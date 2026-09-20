import chalk from 'chalk';
import { cwd } from 'node:process';
import type { Page } from 'playwright';
import type { BrowserSession } from '../browser/session.js';
import type { FreegentConfig } from '../config/config.js';
import {
  sendPrompt as sendDeepSeekPrompt, waitForCompleteResponse as waitDeepSeekResponse, snapshotAssistant as snapshotDeepSeek, startNewChat as startDeepSeekChat,
} from '../browser/deepseek.js';
import {
  sendPrompt as sendGeminiPrompt, waitForCompleteResponse as waitGeminiResponse, snapshotAssistant as snapshotGemini, startNewChat as startGeminiChat,
} from '../browser/gemini.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { buildProjectContext } from '../memory/context.js';
import { executeTool } from '../tools/registry.js';
import { parseToolCall, formatToolResult } from './parser.js';
import { Guards } from './guards.js';

export interface WorkerResult {
  label: string;
  ok: boolean;
  output: string;
  steps: number;
}

/** Cap per worker - a background agent must not run away with the browser. */
const MAX_STEPS = 40;

/** Retries for a stalled send (the prompt likely never reached the composer). */
const STALL_RETRIES = 2;

/**
 * Background workers run in a tab with no human attached. Asking a clarifying
 * question there is a dead end - it burns the agent's turn and returns nothing
 * useful, so the worker is told to decide and state the assumption instead.
 */
const AUTONOMY =
  'You are running headless in a background tab. NOBODY can answer you. ' +
  'NEVER ask a clarifying question and NEVER finish by requesting input. ' +
  'If the task is ambiguous, pick the most reasonable interpretation, do ' +
  'the work, and state the assumption in your finish summary.';

/**
 * Run one task in its OWN browser tab, with its own chat, abort controller
 * and guards. Nothing here touches the parent session's page or state, so
 * several workers can run at the same time without fighting over the tab.
 */
export async function runOnNewTab(
  browser: BrowserSession,
  config: FreegentConfig,
  label: string,
  task: string,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const page: Page = await browser.context.newPage();
  const guards = new Guards();
  guards.startTask();
  let steps = 0;

  try {
    const gemini = config.provider === 'gemini';
    const startChat = gemini ? () => startGeminiChat(page) : () => startDeepSeekChat(page, config.chatUrl);
    const send = gemini
      ? (text: string) => sendGeminiPrompt(page, text)
      : (text: string) => sendDeepSeekPrompt(page, text);
    const snapshotFn = gemini ? () => snapshotGemini(page) : () => snapshotDeepSeek(page);
    const waitFn = gemini
      ? (before: Awaited<ReturnType<typeof snapshotGemini>>) => waitGeminiResponse(page, config.responseIdleMs, config.responseTimeoutMs, before, signal)
      : (before: Awaited<ReturnType<typeof snapshotDeepSeek>>) => waitDeepSeekResponse(page, config.responseIdleMs, config.responseTimeoutMs, before, signal);

    await startChat();
    const projectContext = await buildProjectContext(cwd());
    const system = buildSystemPrompt({ projectContext, cwd: cwd() });
    let snapshot = await snapshotFn();
    let lastSent = `${system}

${AUTONOMY}

## User task
${task}`;
    await send(lastSent);

    for (let i = 0; i < MAX_STEPS; i++) {
      if (signal?.aborted) throw new Error('interrupted');
      steps = i + 1;
      let reply = '';
      for (let attempt = 0; ; attempt++) {
        try {
          reply = await waitFn(snapshot);
          break;
        } catch (err) {
          const msg = (err as Error).message;
          if (!msg.includes('stalled') || attempt >= STALL_RETRIES) throw err;
          console.log(chalk.dim(`  [${label}] stalled, resending (${attempt + 1}/${STALL_RETRIES})`));
          snapshot = await snapshotFn();
          await send(lastSent);
        }
      }
      const call = parseToolCall(reply);
      if (!call) {
        snapshot = await snapshotFn();
        lastSent =
          'PROTOCOL ERROR: no valid tool call. Emit ONE call inside a fenced ' +
          'freegent block now, or tool: finish with a summary.';
        await send(lastSent);
        continue;
      }
      console.log(chalk.dim(`  [${label}] ${call.tool}`));
      const result = await executeTool(call, {
        cwd: cwd(),
        confirmCommands: config.confirmCommands,
        newPage: () => browser.context.newPage(),
        signal,
      }, guards);
      if (result.finished) return { label, ok: true, output: result.output, steps };
      snapshot = await snapshotFn();
      lastSent = formatToolResult(result.ok, result.output);
      await send(lastSent);
    }
    return { label, ok: false, output: `Hit the ${MAX_STEPS}-step limit without finishing.`, steps };
  } catch (err) {
    return { label, ok: false, output: `ERROR: ${(err as Error).message}`, steps };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * One prompt, one reply, own tab, no tool loop. Used by the boss to plan
 * before any worker touches a file.
 */
export async function askOnNewTab(
  browser: BrowserSession,
  config: FreegentConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const page: Page = await browser.context.newPage();
  try {
    if (config.provider === 'gemini') {
      await startGeminiChat(page);
      const before = await snapshotGemini(page);
      await sendGeminiPrompt(page, prompt);
      return waitGeminiResponse(page, config.responseIdleMs, config.responseTimeoutMs, before, signal);
    }
    await startDeepSeekChat(page, config.chatUrl);
    const before = await snapshotDeepSeek(page);
    await sendDeepSeekPrompt(page, prompt);
    return waitDeepSeekResponse(page, config.responseIdleMs, config.responseTimeoutMs, before, signal);
  } finally {
    await page.close().catch(() => undefined);
  }
}
