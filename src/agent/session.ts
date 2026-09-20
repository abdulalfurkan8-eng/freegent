import ora from 'ora';
import chalk from 'chalk';
import { cwd } from 'node:process';
import { basename, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { buildSystemPrompt, buildFollowUpPrompt, cullPromptByTask } from '../prompts/system.js';
import { buildProjectContext } from '../memory/context.js';
import { loadConfig, type FreegentConfig } from '../config/config.js';
import { openSession, type BrowserSession } from '../browser/session.js';
import {
  ensureLoggedIn, sendPrompt, waitForCompleteResponse, snapshotAssistant,
  startNewChat, openChatByUrl, currentChatUrl, enableFeatureToggles, recoverStuckPage,
} from '../browser/deepseek.js';
import { attachFile } from '../browser/upload.js';
import { executeTool, MUTATING, READ_TOOLS } from '../tools/registry.js';
import { quickTestCheck } from '../tools/terminal/exec.js';
import { clearTodos, hasTodos, renderTodos, todoOverlay, todoTouched, resetTodoTouch } from '../tools/todo.js';
import { registerActiveSpinner } from '../utils/spinnerRegistry.js';
import { parseToolCall, formatToolResult, looksTruncated } from './parser.js';
import { appendMemory } from '../memory/store.js';
import { upsertSession, renameSessionById, type ChatSession } from '../memory/sessions.js';
import {
  renderToolCall, renderToolResult, renderAssistantText, describeCall,
  renderCompactStep,
} from '../utils/render.js';
import { logger } from '../utils/logger.js';
import { isTermux } from '../utils/platform.js';
import { runSkepticReview } from './skeptic.js';
import { loadProjectPatterns } from '../memory/patterns.js';
import { retrieveAdvanced, rememberAdvanced, formatAdvancedMemory } from '../memory/advanced.js';
import { Guards } from './guards.js';
import { askOnNewTab, runOnNewTab, type WorkerResult } from './worker.js';
import { AgentState } from './state.js';
import { AgentRuntime } from './runtime.js';
import { appendTaskJournal } from './journal.js';
import { strategyPrompt } from './strategy.js';
import { DEFAULTS } from '../config/defaults.js';
import { BrowserLLMProvider, BrowserGeminiLLMProvider, type LLMProvider } from './provider.js';
import * as GeminiBrowser from '../browser/gemini.js';
import { recordStrategyOutcome, learnedStrategy } from './learning.js';
import { buildRelevantContext } from './context.js';
import { metric } from './observability.js';
import { assessRisk } from '../security/permissions.js';
import { tryFastComputerTask } from './fastComputer.js';
import { startPowerShellKeepalive, closePowerShell, ensureComputerRuntime } from '../windows/powershell.js';
import { overlayStart, overlayStop, foregroundWindow } from '../windows/computer.js';
import { formatAppLibraryContext, matchAppProfiles } from '../app-library/index.js';

export interface AgentStats {
  tasks: number;
  toolCalls: number;
  tokensUsed: number;
  startedAt: number;
}

export class AgentSession {
  browser: BrowserSession | null = null;
  private config!: FreegentConfig;
  private contextSent = false;
  private sessionId = `s-${Date.now().toString(36)}`;
  private sessionName = 'untitled';
  private pendingImages: string[] = [];
  /** Set when an image failed to attach - warns the model it never saw it. */
  private imageWarning = '';
  private abort: AbortController | null = null;
  private forkRecap = '';
  private sideMode = false;
  private llmProvider: LLMProvider | null = null;
  /** Incremental runtime projection; perception modules can extend it without
   * coupling themselves to the browser/chat implementation. */
  readonly state: AgentState;
  /** Durable execution discipline: phase, failure budget, recovery guidance. */
  readonly runtime: AgentRuntime;

  constructor(state = new AgentState(), runtime = new AgentRuntime(cwd())) {
    this.state = state;
    this.runtime = runtime;
  }
  /** Next task runs in enforced plan mode (mutating tools blocked). */
  planNext = false;
  readonly stats: AgentStats = { tasks: 0, toolCalls: 0, tokensUsed: 0, startedAt: Date.now() };
  /** What the most recent task did - fed to the completion line and footer. */
  readonly lastTask = { toolCalls: 0, filesChanged: 0, unverified: 0 };

  /**
   * DeepSeek's web UI exposes no token-usage API (this is browser automation,
   * not the real API), so there is no authoritative count available. Estimate
   * from character length instead of showing a permanent 0 - ~4 chars/token
   * is the standard rough heuristic, already used elsewhere in this codebase
   * for memory-context sizing.
   */
  trackTokens(content: string): void {
    if (!content) return;
    this.stats.tokensUsed += Math.ceil(content.length / 4);
  }

  async start(shared?: BrowserSession): Promise<void> {
    startPowerShellKeepalive();
    if (process.platform === 'win32') await ensureComputerRuntime().catch((err) => logger.warn(`Windows computer-control runtime unavailable: ${(err as Error).message}`));
    this.config = await loadConfig();
    if (process.platform === 'win32') await overlayStart().catch(() => undefined);

    if (this.config.provider === 'gemini') {
      this.browser = await openSession(this.config, false);
      this.llmProvider = new BrowserGeminiLLMProvider(this.browser.page, this.config.responseIdleMs, this.config.responseTimeoutMs);
      const { ensureLoggedIn: ensureGeminiLoggedIn, startNewChat: startGeminiNewChat } = await import('../browser/gemini.js');
      await ensureGeminiLoggedIn(this.browser.page);
      await startGeminiNewChat(this.browser.page);
      logger.info('Connected to Gemini web');
      return;
    }

    if (shared) {
      // Parallel chat lane: reuse the logged-in browser, own tab own chat.
      this.browser = shared;
      this.llmProvider = new BrowserLLMProvider(this.browser.page, this.config.responseIdleMs, this.config.responseTimeoutMs);
      await startNewChat(this.browser.page, this.config.chatUrl);
      if (isTermux()) await enableFeatureToggles(this.browser.page).catch(() => undefined);
      return;
    }
    const spinner = ora({ text: 'Connecting to DeepSeek...', discardStdin: false }).start();
    try {
      this.browser = await openSession(this.config, false);
      this.llmProvider = new BrowserLLMProvider(this.browser.page, this.config.responseIdleMs, this.config.responseTimeoutMs);
      await ensureLoggedIn(this.browser.page);
      await startNewChat(this.browser.page, this.config.chatUrl);
      if (isTermux()) await enableFeatureToggles(this.browser.page).catch(() => undefined);
      spinner.succeed('Connected to DeepSeek');
    } catch (err) {
      spinner.fail('Could not connect to DeepSeek');
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.saveSession();
    if (this.browser) await this.browser.close();
    this.browser = null;
    await this.llmProvider?.close?.();
    this.llmProvider = null;
    if (process.platform === 'win32') await overlayStop().catch(() => undefined);
    closePowerShell();
  }

  private async saveSession(): Promise<void> {
    if (!this.browser || !this.contextSent || this.sideMode) return;
    const record: ChatSession = {
      id: this.sessionId,
      name: this.sessionName === 'untitled' ? basename(cwd()) : this.sessionName,
      url: currentChatUrl(this.browser.page),
      cwd: cwd(),
      createdAt: new Date(this.stats.startedAt).toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await upsertSession(record).catch(() => undefined);
  }

  async rename(name: string): Promise<void> {
    this.sessionName = name;
    await this.saveSession();
    await renameSessionById(this.sessionId, name).catch(() => undefined);
  }

  /** Short unique code for this chat - shown after the name in history. */
  get shortId(): string { return this.sessionId.slice(-4); }

  /** Stable id used to store this chat's message history on disk. */
  get chatId(): string { return this.sessionId; }

  /**
   * AI-name this chat from its first task (a quick side-tab ask). Falls
   * back to the task's own words if the ask fails. Never throws.
   */
  async autoName(task: string): Promise<string> {
    if (this.sessionName !== 'untitled') return this.sessionName;
    let title = '';
    try {
      if (this.config.provider === 'gemini' && this.llmProvider) {
        const raw = await this.llmProvider.send(
          'Give a short 2-4 word name for a coding chat about the task below. Reply with ONLY the name - no quotes, no period.\n\nTask: ' + task.slice(0, 400),
        );
        const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        title = (lines.pop() ?? '').replace(/["'.`*#]/g, '').trim().slice(0, 36);
      } else if (this.browser) {
        const raw = await askOnNewTab(this.browser, this.config,
          'Give a short 2-4 word name for a coding chat about the task ' +
          'below. Reply with ONLY the name - no quotes, no period.\n\n' +
          'Task: ' + task.slice(0, 400));
        const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        title = (lines.pop() ?? '').replace(/["'.`*#]/g, '').trim().slice(0, 36);
      }
    } catch { /* offline or side tab failed - fall back below */ }
    if (!title) {
      title = task.replace(/^\/\S+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 30) || 'chat';
    }
    await this.rename(title);
    return this.sessionName;
  }

  async resume(target: ChatSession): Promise<void> {
    if (!this.browser) throw new Error('Session not started');
    if (this.config.provider === 'gemini') await GeminiBrowser.openChatByUrl(this.browser.page, target.url);
    else await openChatByUrl(this.browser.page, target.url);
    this.sessionId = target.id;
    this.sessionName = target.name;
    this.contextSent = true;
  }

  async newChat(): Promise<void> {
    if (this.config.provider === 'gemini') {
      if (!this.browser) throw new Error('Session not started');
      const { startNewChat: startGeminiNewChat } = await import('../browser/gemini.js');
      await startGeminiNewChat(this.browser.page);
      this.llmProvider = new BrowserGeminiLLMProvider(this.browser.page, this.config.responseIdleMs, this.config.responseTimeoutMs);
      this.sessionId = `s-${Date.now().toString(36)}`;
      this.sessionName = 'untitled';
      this.contextSent = false;
      this.forkRecap = '';
      return;
    }
    if (!this.browser) throw new Error('Session not started');
    await this.saveSession();
    await startNewChat(this.browser.page, this.config.chatUrl);
    if (isTermux()) await enableFeatureToggles(this.browser.page).catch(() => undefined);
    this.sessionId = `s-${Date.now().toString(36)}`;
    this.sessionName = 'untitled';
    this.contextSent = false;
  }

  async compact(): Promise<string> {
    const summary = await this.runTask(
      'Write a handoff summary: 1) task/goal, 2) files created/modified, ' +
      '3) key decisions, 4) verified-working state, 5) unresolved items. ' +
      'Respond ONLY with the finish tool; put the summary in "summary".',
    );
    const keepName = this.sessionName;
    await this.newChat();
    this.sessionName = keepName === 'untitled' ? 'untitled' : keepName;
    this.forkRecap = `Continuing from a compacted session. Handoff:\n${summary}`;
    return summary;
  }

  async queueImage(path: string): Promise<string> {
    const abs = resolve(cwd(), path);
    await access(abs);
    this.pendingImages.push(abs);
    return abs;
  }

  get displayName(): string { return this.sessionName; }

  async fork(name?: string): Promise<void> {
    if (!this.browser) throw new Error('Session not started');
    await this.saveSession();
    const { loadMemory } = await import('../memory/store.js');
    const history = await loadMemory();
    const recap = history.slice(-20)
      .map((m) => `[${m.role}] ${m.content.slice(0, 300)}`).join('\n').slice(-4000);
    if (this.config.provider === 'gemini') await GeminiBrowser.startNewChat(this.browser.page);
    else await startNewChat(this.browser.page, this.config.chatUrl);
      if (isTermux()) await enableFeatureToggles(this.browser.page).catch(() => undefined);
    this.sessionId = `s-${Date.now().toString(36)}`;
    this.sessionName = name ?? `${this.sessionName}-fork`;
    this.contextSent = false;
    this.forkRecap = recap;
  }

  async runSideTask(task: string): Promise<string> {
    if (!this.browser) throw new Error('Session not started');
    const page = this.browser.page;
    const prevUrl = currentChatUrl(page);
    const prevContextSent = this.contextSent;
    this.sideMode = true;
    if (this.config.provider === 'gemini') await GeminiBrowser.startNewChat(page);
    else await startNewChat(page, this.config.chatUrl);
    if (isTermux() && this.config.provider !== 'gemini') await enableFeatureToggles(page).catch(() => undefined);
    this.contextSent = false;
    try {
      return await this.runTask(`[Side task - self-contained] ${task}`);
    } finally {
      this.sideMode = false;
      this.contextSent = prevContextSent;
      if (this.config.provider === 'gemini') await GeminiBrowser.openChatByUrl(page, prevUrl);
      else await openChatByUrl(page, prevUrl);
    }
  }

  /**
   * Run tasks in their own browser tabs, concurrently. Each worker gets a
   * fresh chat and independent state, so this never disturbs the main tab.
   */
  async runParallel(jobs: Array<{ label: string; task: string }>): Promise<WorkerResult[]> {
    if (!this.browser) throw new Error('Session not started');
    const browser = this.browser;
    const config = this.config;
    const signal = this.abort?.signal;
    const limit = DEFAULTS.agent.maxParallelWorkers;
    const out: WorkerResult[] = new Array(jobs.length); let next = 0;
    const worker = async (): Promise<void> => { while (true) { const i = next++; if (i >= jobs.length) return; out[i] = await runOnNewTab(browser, config, jobs[i].label, jobs[i].task, signal); } };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()));
    return out;
  }

  /** One prompt, one reply, own tab. No tools - used for planning. */
  async askOnce(prompt: string): Promise<string> {
    if (this.config.provider === 'gemini') {
      if (!this.llmProvider) throw new Error('Session not started');
      return this.llmProvider.send(prompt, this.abort?.signal);
    }
    if (!this.browser) throw new Error('Session not started');
    return askOnNewTab(this.browser, this.config, prompt, this.abort?.signal);
  }

  cancel(): void { this.abort?.abort(); }
  get running(): boolean { return this.abort !== null; }

  /** Run one task to completion inside the persistent chat. */
  async runTask(task: string): Promise<string> {
    const isGemini = this.config.provider === 'gemini';
    const computerControlOnly = /(?:mouse\s*(?:and|&)\s*keyboard|keyboard\s*(?:and|&)\s*mouse|computer\s*control|do\s*not\s*use\s*(?:a\s*)?script|don't\s*use\s*(?:a\s*)?script|no\s*(?:app(?:lication)?\s*)?script)/i.test(task);
    if (!this.llmProvider) throw new Error('Session not started');
    if (!isGemini && !this.browser) throw new Error('Session not started');
    const page = this.browser?.page;
    this.stats.tasks++;
    // Every user prompt starts a fresh live checklist. The previous task's
    // completed todo must never remain floating over the next prompt while
    // the model is deciding its new plan.
    clearTodos();
    resetTodoTouch();
    const toolCallsAtStart = this.stats.toolCalls;
    const guards = new Guards();
    guards.startTask(task);
    this.state.resetTask(task);
    await this.runtime.start(task);
    await this.runtime.transition('investigate', 'Task accepted; inspect before mutation when evidence is needed.');

    // App Library: only spend the local perception round when the task is
    // actually about operating an application. Matching uses both the user's
    // task and the current foreground process/title, so an app profile can be
    // selected even when the task does not name the application explicitly.
    const appControlTask = /\b(?:open|launch|use|control|click|double[- ]?click|right[- ]?click|type|press|drag|move|scroll|send|message|edit|draw|render)\b|\b(?:blender|vscode|visual studio code|notepad|chrome|edge|file explorer|windows terminal|powershell|paint|calculator|whatsapp)\b/i.test(task);
    let appLibraryContext = '';
    if (process.platform === 'win32' && appControlTask) {
      try {
        const active = await foregroundWindow();
        const profiles = await matchAppProfiles(task, active ?? undefined);
        appLibraryContext = formatAppLibraryContext(profiles, active ?? undefined, task);
      } catch { /* App Library is an optimization; GUI work can still proceed. */ }
    }

    // Deterministic Windows fast lane: simple GUI commands never consume a
    // DeepSeek planning turn. Complex/ambiguous tasks continue to the model.
    if (process.platform === 'win32' && !this.planNext) {
      try {
        const fast = await tryFastComputerTask(task);
        if (fast.handled) {
          this.stats.toolCalls += 1;
          this.lastTask.toolCalls = 1;
          const fastResultText = fast.output ?? '';
          await this.runtime.result(true, fastResultText || 'deterministic computer action completed', 'fast-path');
          await this.runtime.verify(true, 'deterministic computer action completed');
          if (fastResultText) {
            await appendMemory({ role: 'tool', content: fastResultText, timestamp: new Date().toISOString() });
          }
          return fastResultText;
        }
      } catch (err) {
        // Fast lane is an optimization, never a reason to fail the task.
      }
    }
    guards.planMode = this.planNext;
    this.planNext = false;
    await appendMemory({ role: 'user', content: task, timestamp: new Date().toISOString() });
    const relevantMemory = await retrieveAdvanced(task, cwd(), 12).catch(() => []);
    this.state.setMemoryContext(relevantMemory.map((m) => `[${m.kind}] ${m.text}`));
    if (relevantMemory.length) {
      // Keep the model context selective: only high-scoring memories enter the prompt.
    }

    let prompt: string;
    if (!this.contextSent) {
      const projectContext = await buildProjectContext(cwd());
      const recap = this.forkRecap ? `\n\n## Forked conversation recap\n${this.forkRecap}` : '';
      this.forkRecap = '';
      // Load learned patterns from similar past projects
      const libs: string[] = projectContext.includes('package.json') ? (projectContext.match(/[\w-]+/g) || []) : [];
      const patterns = await loadProjectPatterns(libs);
      const learned = await learnedStrategy(/blender|photoshop|premiere|unity|cad|gui|ui|visual/i.test(task) ? 'gui' : 'coding');
      let systemPrompt = buildSystemPrompt({ cwd: cwd(), projectContext });
      // Cull irrelevant guidance to reduce token bloat
      systemPrompt = cullPromptByTask(systemPrompt, task);
      // Connected MCP tool packs (global ~/.freegent/mcp, enabled only)
      const { buildMcpPromptBlock } = await import('../commands/mcp.js');
      const mcpBlock = await buildMcpPromptBlock().catch(() => '');
      const memoryText = buildRelevantContext(relevantMemory.map((m) => ({ text: `[${m.kind}] ${m.text}`, source: 'memory', score: m.importance + m.confidence, tokens: Math.ceil(m.text.length / 4) })), 6000);
      const memoryBlock = memoryText ? `\n\n## Relevant FreeGent memory\n${memoryText}` : '';
      prompt =
        `${systemPrompt}${recap}${patterns ? '\n\n' + patterns : ''}${learned.length ? `\n\n## Learned successful strategies\n${learned.join('\n')}` : ''}${memoryBlock}` +
        `${appLibraryContext ? `\n\n${appLibraryContext}` : ''}` +
        `\n\n## Runtime strategy guidance\n${strategyPrompt(task)}${this.runtime.context()}` +
        `${mcpBlock ? '\n\n' + mcpBlock : ''}\n\n## User task\n${task}`;
      this.contextSent = true;
      // Name the chat from its first message in the background (AI-given
      // title, falls back to the task's own words) - never blocks the task
      // itself, and /rename still works normally afterward either way.
      void this.autoName(task).catch(() => undefined);
    } else {
      const libs: string[] = [];
      const patterns = await loadProjectPatterns(libs);
      const learned = await learnedStrategy(/blender|photoshop|premiere|unity|cad|gui|ui|visual/i.test(task) ? 'gui' : 'coding');
      const activeProfileDirective = appLibraryContext
        ? `\n\n## ACTIVE APP LIBRARY DIRECTIVE\n${appLibraryContext}\n\nFor this task, the PRIMARY MATCH above is authoritative baseline guidance. Start from its relevant workflow instead of performing generic app-discovery or shell-probing. Only deviate after observing a concrete mismatch or failure.`
        : '';
      prompt = buildFollowUpPrompt(task) + (patterns ? '\n\n' + patterns : '') + activeProfileDirective;
    }

    this.abort = new AbortController();
    const signal = this.abort.signal;
    const spinner = ora({
      text: 'Thinking...',
      spinner: {
        interval: 720,
        frames: ['◴', '◷', '◶', '◵', '◴', '◷', '◶', '◵'],
      },
      discardStdin: false,
    }).start();
    registerActiveSpinner(spinner);
    let snapshot: Awaited<ReturnType<typeof snapshotAssistant>> | null = isGemini ? null : await snapshotAssistant(page!);
    let pendingReply: string | null = null;
    const sendNextModelMessage = async (message: string, images: string[] = [], countTokens = true): Promise<void> => {
      if (isGemini) {
        pendingReply = await this.llmProvider!.send(message, signal, images);
      } else {
        for (const image of images) await attachFile(page!, image);
        snapshot = await snapshotAssistant(page!);
        try {
          await sendPrompt(page!, message);
        } catch (err) {
          // Composer stayed wedged even after sendPrompt's own internal
          // reload+retry. One page-level recovery attempt before giving up.
          const healed = await recoverStuckPage(page!);
          if (!healed) throw err;
          snapshot = await snapshotAssistant(page!);
          await sendPrompt(page!, message);
        }
      }
      // The huge injected system/context prompt is not real "conversation"
      // content, so it must never inflate the token counter. Callers that
      // send it (the very first message of a task) pass countTokens=false
      // and track just the actual task text themselves right after.
      if (countTokens) this.trackTokens(message);
    };
    const initialImages = this.pendingImages.splice(0);
    await sendNextModelMessage(prompt, initialImages, false);
    // Count only the user's task text, not the large system/context prompt.
    this.trackTokens(task);

    try {
      let nudges = 0;
      let noToolStreak = 0;
      let finishGateUsed = false;
      let lastFailSig = '';
      let selfReviewDone = false;
      let recoveredOnce = false;

      // Todo checklist floats ON TOP (spinner prefixText), status line at the
      // bottom. setSpin keeps the block alive across tool runs and sends so
      // it never blinks out mid-task.
      let lastTodoOverlay = '';
      const toolPhase = (tool: string): string => {
        if (['read_file', 'read_files', 'list_dir', 'tree', 'search', 'symbols', 'deps'].includes(tool)) return 'Analyzing';
        if (['write_file', 'append_file', 'edit_file', 'delete_file'].includes(tool)) return 'Building';
        if (['run_command', 'shell', 'git', 'test_page', 'check'].includes(tool)) return 'Testing';
        if (['visual', 'screenshot', 'browser'].includes(tool)) return 'Reviewing';
        if (['research', 'web_fetch'].includes(tool)) return 'Researching';
        if (['todo', 'remember'].includes(tool)) return 'Planning';
        return 'Working';
      };
      const setSpin = (status: string): void => {
        const nextTodoOverlay = hasTodos() ? todoOverlay() + '\n' : '';
        if (nextTodoOverlay !== lastTodoOverlay) {
          spinner.prefixText = nextTodoOverlay;
          lastTodoOverlay = nextTodoOverlay;
        }
        spinner.text = status;
        if (!spinner.isSpinning) spinner.start();
      };

      for (let i = 0; i < this.config.maxIterations; i++) {
        const step = `step ${i + 1}`;
        setSpin(`Working... ${chalk.dim(step)}`);
        const waitStart = Date.now();
        let liveReplyChars = 0; // grows as DeepSeek streams the reply
        let shownTokens = this.stats.tokensUsed; // eased value for smooth counting
        const tick = setInterval(() => {
          const s = Math.round((Date.now() - waitStart) / 1000);
          const target = this.stats.tokensUsed; // character-based estimate (~4 chars/token) - no real tokenizer exposed by the browser transport
          // Ease toward target so the number counts up smoothly, not in jumps.
          const diff = target - shownTokens;
          shownTokens += Math.abs(diff) < 2 ? diff : Math.ceil(diff * 0.25);
          const tokStr = shownTokens < 1000 ? `${shownTokens}` : `${(shownTokens / 1000).toFixed(1)}k`;
          const nextTodoOverlay = hasTodos() ? todoOverlay() + '\n' : '';
          if (nextTodoOverlay !== lastTodoOverlay) {
            spinner.prefixText = nextTodoOverlay;
            lastTodoOverlay = nextTodoOverlay;
          }
          spinner.text = `${chalk.white('Working')} ${chalk.dim(`${step} · ${s}s · ↓ ${tokStr} tokens`)}`;
        }, 1000);
        let reply: string;
        try {
          if (isGemini) {
            reply = pendingReply ?? await this.llmProvider!.send('Continue with your next tool call.', signal);
            pendingReply = null;
          } else {
            reply = await waitForCompleteResponse(
              page!, this.config.responseIdleMs, this.config.responseTimeoutMs, snapshot!, signal,
              (chars) => { liveReplyChars = chars; },
            );
          }
          const classification = /TASK_CLASSIFICATION:\s*(visual|nonvisual)/i.exec(reply)?.[1]?.toLowerCase();
          if (classification === 'visual' || classification === 'nonvisual') guards.setTaskClassification(classification);
          this.trackTokens(reply);
          nudges = 0;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Timed out') && nudges < 2 && !signal.aborted) {
            nudges++;
            spinner.text = `No response — nudging (retry ${nudges}/2)...`;
            await sendNextModelMessage('Continue with your next tool call.');
            continue;
          }
          if (!isGemini && !signal.aborted && !recoveredOnce) {
            recoveredOnce = true;
            spinner.text = 'Connection stalled - reloading DeepSeek tab...';
            const healed = await recoverStuckPage(page!);
            if (healed) {
              try {
                snapshot = await snapshotAssistant(page!);
                await sendPrompt(page!, 'Continue with your next tool call.');
                nudges = 0;
                continue;
              } catch { /* fall through to throw below */ }
            }
          }
          throw err;
        } finally { clearInterval(tick); }

        await appendMemory({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
        spinner.prefixText = ''; // clear overlay before stopping (floats back in via setSpin)
        spinner.stop();

        const call = parseToolCall(reply);
        if (!call) {
          const truncated = looksTruncated(reply);
          if (!truncated) renderAssistantText(reply);
          if (truncated) {
            console.log(chalk.yellow('  ⚠ Reply truncated — asking for chunked rewrite...'));
            await sendNextModelMessage(
              'Your last message was TRUNCATED — the tool call never completed. ' +
              'Do NOT retry the same large call. Use read_file to see how far the ' +
              'file got, then continue with append_file in chunks of ≤80 lines. ' +
              'Respond with ONE tool call now (inside a fenced freegent block).');
            continue;
          }
          noToolStreak++;
          if (noToolStreak < 3) {
            const errorMsg = 'PROTOCOL ERROR: no valid tool call found. Emit ONE call inside a fenced freegent block (the fence is MANDATORY):\n```freegent\ntool: read_file\npath: src/index.ts\n```\nOr for files:\n```freegent\ntool: write_file\npath: out.js\n<<<CONTENT\n...raw code...(indentation preserved)\nCONTENT>>>\n```\nEmit ONE call now.';
            await sendNextModelMessage(errorMsg);
            continue;
          }
          console.log(chalk.yellow('  ⚠ Protocol drift — recommend /clear or /compact.'));
          return 'Protocol drift: use /clear or /compact, then retry.';
        }
        noToolStreak = 0;

        const verbose = ['verbose', 'debug'].includes(logger.getLevel());
        const compact = READ_TOOLS.has(call.tool) && !verbose;
        if (!compact) renderAssistantText(reply);
        if (call.tool !== 'finish' && !compact) renderToolCall(call.tool, describeCall(call));

        this.stats.toolCalls++;
        this.state.beginAction(call.tool, { ...call });
        await this.runtime.beginAction({
          intent: `${call.tool} ${String(call.action ?? call.path ?? call.command ?? '')}`.trim(),
          tool: call.tool,
          expectedChange: call.tool === 'finish' ? 'task completion' : 'observable progress toward the goal',
          verification: call.tool === 'finish' ? 'finish gates, self-review, and skeptic review' : 'observe the resulting tool/application state',
          fallback: 're-observe and use a materially different strategy after repeated failure',
          risk: ['delete_file','run_command','shell'].includes(call.tool) ? 'high' : (['write_file','edit_file','append_file','computer','windows'].includes(call.tool) ? 'medium' : 'low'),
        });
        setSpin(chalk.white(`${toolPhase(call.tool)} `) + chalk.dim(`${call.tool}...`));
        const result = await executeTool(call, {
          cwd: cwd(),
          confirmCommands: this.config.confirmCommands,
          newPage: () => { if (!this.browser) throw new Error('Browser tool unavailable'); return this.browser.context.newPage(); },
          signal,
          computerControlOnly,
          attachImage: (p) => this.pendingImages.push(p),
          spawn: (jobs) => this.runParallel(jobs),
          state: this.state,
        }, guards);
        spinner.prefixText = ''; // clear overlay before stopping (floats back in via setSpin)
        spinner.stop(); // pause the float so result lines print cleanly

        if (signal.aborted) throw new Error('interrupted');
        this.state.endAction(result.ok);
        await this.runtime.result(result.ok, result.output, JSON.stringify(call));
        if (['run_command','check','test_page','screenshot','visual','phone','windows','computer','screen_observe'].includes(call.tool) && result.ok) await this.runtime.verify(true, `${call.tool} completed and returned evidence`);
        if (!result.ok && this.runtime.shouldChangeStrategy()) {
          await this.runtime.recover(result.output.slice(0, 500), this.runtime.recoveryGuidance());
        }
        if (call.tool === 'research' && result.ok) guards.noteResearch();
        if (call.tool === 'visual' && result.ok) guards.noteVisualReview(result.output);
        await appendMemory({ role: 'tool', content: result.output, timestamp: new Date().toISOString() });
        if (result.ok && call.tool !== 'screen_observe') {
          await rememberAdvanced({ kind: call.tool === 'computer' || call.tool === 'windows' ? 'computer' : 'episodic', text: `${call.tool}: ${result.output.slice(0, 900)}`, timestamp: new Date().toISOString(), importance: call.tool === 'computer' || call.tool === 'windows' ? 0.35 : 0.2, confidence: 0.8, project: cwd(), tags: [call.tool] }).catch(() => undefined);
        }

        if (result.finished) {
          if (guards.requiresVisualReview && guards.visualDesignNeedsAttention && guards.changedThisTask.size > 0) {
            guards.visualDesignNeedsAttention = false;
            console.log(chalk.yellow('  ⚠ visual review flagged design quality issues; another improvement pass is required.'));
            await sendNextModelMessage(
              'VISUAL REVIEW FLAGGED DESIGN QUALITY ISSUES. Re-open the current screenshot mentally from the visual result, identify the actual problems, and improve the UI before finishing. Keep the design professional, clear, mature, content-rich, and free of unnecessary cartoon/emoji styling. After editing, call visual again and then finish.');
            continue;
          }
          if (guards.requiresVisualReview && !guards.visualReviewDone && guards.changedThisTask.size > 0) {
            console.log(chalk.yellow('  ⚠ finish rejected — visual review was not completed.'));
            await sendNextModelMessage(
              'FINISH REJECTED: visually inspect the result before finishing. Use visual on the relevant HTML page(s), ' +
              'inspect the rendered result, fix generic/broken/weak areas, then verify again and finish.');
            continue;
          }
          if (guards.unverified.size > 0 && !finishGateUsed) {
            finishGateUsed = true;
            const files = [...guards.unverified].join(', ');
            console.log(chalk.yellow(`  ⚠ finish rejected — unverified: ${files}`));
            await sendNextModelMessage(
              `FINISH REJECTED: changed but never verified: ${files}\n` +
              'Run check/test_page/run_command that exercises those files. ' +
              'Fix every error, re-verify until clean, THEN finish.');
            continue;
          }
          if (guards.changedThisTask.size > 1 && !selfReviewDone) {
            selfReviewDone = true;
            const changed = [...guards.changedThisTask].join(', ');
            await sendNextModelMessage(
              `SELF-REVIEW before finishing. You changed: ${changed}\n` +
              'Re-read each file, hunt for off-by-one, null, wrong paths, dead code. ' +
              'List real problems and fix them, or reply "clean". Then finish.');
            continue;
          }
          // Run skeptic review: independent agent looks for flaws in changed files
          try {
            const findings = isGemini ? [] : await runSkepticReview(guards.changedThisTask, this.browser!);
            const errors = findings.filter((f) => f.severity === 'error');
            if (errors.length > 0) {
              const issueList = errors.map((f) => `  - ${f.suggestion}`).join('\n');
              console.log(chalk.yellow(`  ⚠ skeptic found ${errors.length} issue(s):`));
              console.log(issueList);
              await sendNextModelMessage(
                `SKEPTIC REVIEW found issues:\n${issueList}\n` +
                'Fix these issues, then finish again. Report only concise evidence and verification; do not expose private chain-of-thought.');
              continue;
            }
          } catch (err) {
            // Skeptic failure is non-fatal; just move on
            logger.warn(`Skeptic review error: ${(err as Error).message}`);
          }
          this.state.complete();
          await this.runtime.complete(result.output.slice(0, 1200));
          await appendTaskJournal(cwd(), {
            id: this.chatId + '-' + Date.now().toString(36), goal: task, startedAt: new Date().toISOString(),
            status: 'completed', completedSteps: [], failedAttempts: [], changedFiles: [...guards.changedThisTask], assumptions: [],
          });
          await this.saveSession();
          return result.output;
        }

        if (compact) {
          renderCompactStep(call.tool, describeCall(call), result.output, result.ok);
        } else {
          renderToolResult(result.output, result.ok, result.display);
        }

        // Continuous test loop: run tests immediately after mutations (fail-fast)
        if (result.ok && MUTATING.has(call.tool) && typeof call.path === 'string') {
          const testError = await quickTestCheck(call.path);
          if (testError) {
            console.log(chalk.yellow('  ⚠ Tests failed immediately after mutation:'));
            console.log(chalk.dim(testError));
            await sendNextModelMessage(
              `IMMEDIATE TEST FAILURE after ${call.tool} on ${call.path}:\n${testError}\n` +
              'Fix this breakage before continuing.');
            continue;
          }
        }

        if (signal.aborted) throw new Error('interrupted');

        if (process.platform === 'win32' && appControlTask && ['computer', 'windows', 'screen_observe'].includes(call.tool)) {
          try {
            const active = await foregroundWindow();
            const profiles = await matchAppProfiles(task, active ?? undefined);
            appLibraryContext = formatAppLibraryContext(profiles, active ?? undefined, task);
          } catch { /* retain the last good profile context */ }
        }

        let feedback = result.output;
        if (appLibraryContext) feedback += `\n\n${appLibraryContext}`;
        // Give the model a compact, incremental world-state projection instead
        // of repeatedly rebuilding the whole perception/memory context.
        feedback += `\n\nRUNTIME_STATE: ${this.state.contextForModel()}`;
        feedback += `\n\nEXECUTION_RUNTIME: ${this.runtime.context()}`;
        if (this.imageWarning) {
          feedback += this.imageWarning;
          this.imageWarning = '';
        }
        if (!result.ok) {
          const sig = JSON.stringify(call);
          if (sig === lastFailSig) {
            feedback += '\n\nSTOP: this exact call already failed. Do not retry it. ' +
              'Diagnose differently: read the file, probe the API, try another approach.';
          }
          lastFailSig = sig;
        } else {
          lastFailSig = '';
        }

        setSpin(`Working... ${chalk.dim(step)}`);
        const nextImages = this.pendingImages.splice(0);
        await sendNextModelMessage(formatToolResult(result.ok, feedback), nextImages);
      }

      spinner.prefixText = '';
      spinner.stop();
      this.state.pause();
      console.log(chalk.yellow(`  ⏸ Paused after ${this.config.maxIterations} steps.`));
      return 'Paused at step limit — type "continue" to keep going.';
    } catch (err) {
      this.state.fail();
      throw err;
    } finally {
      this.abort = null;
      registerActiveSpinner(null);
      spinner.prefixText = '';
      spinner.stop();
      // Task over: the list stops floating and lands in scrollback as text.
      if (todoTouched() && hasTodos()) renderTodos();
      this.lastTask.toolCalls = this.stats.toolCalls - toolCallsAtStart;
      this.lastTask.filesChanged = guards.changedThisTask.size;
      this.lastTask.unverified = guards.unverified.size;
      metric('task.durationMs', Date.now() - this.stats.startedAt);
      metric('task.toolCalls', this.lastTask.toolCalls);
      await recordStrategyOutcome({ strategy: this.runtime.currentPhase, taskClass: guards.requiresVisualReview ? 'gui' : 'coding', success: this.state.snapshot().task.status === 'completed', attempts: this.lastTask.toolCalls, durationMs: Date.now() - this.stats.startedAt });
      await this.saveSession();
    }
  }
}