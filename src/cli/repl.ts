import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import chalk from 'chalk';
import { cwd } from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { AgentSession } from '../agent/session.js';
import { PasteHandler } from './pasteHandler.js';
import { printBanner, VERSION } from '../utils/banner.js';
import { clearMemory } from '../memory/store.js';
import { loadSessions, findSession } from '../memory/sessions.js';
import { saveClipboardImage } from '../utils/clipboard.js';
import { rewind } from '../memory/checkpoints.js';
import { clearTodos } from '../tools/todo.js';
import { listShells, runningCount, stopAllShells, stopShell } from '../tools/terminal/shells.js';
import { logger } from '../utils/logger.js';
import { getLastCollapsed } from '../utils/render.js';
import { runResearch } from '../commands/research.js';
import { runBossMode } from '../agent/boss.js';
import { listSkills, readSkill, runSkillCreate, runSkillUpdate, runSkillPipeline, deleteSkill } from '../commands/skill.js';
import { listMcps, printMcpList, setMcpEnabled, deleteMcp, runMcpCreate } from '../commands/mcp.js';
import { setConfirmHandler } from '../utils/confirm.js';
import { pauseActiveSpinnerForPrompt, resumeActiveSpinnerAfterPrompt } from '../utils/spinnerRegistry.js';

/** Load a custom command from .freegent/commands/<name>.md, if present. */
async function loadCustomCommand(name: string, args: string): Promise<string | null> {
  try {
    let md = await readFile(join(cwd(), '.freegent', 'commands', `${name}.md`), 'utf8');
    md = md.replace(/^---[\s\S]*?---\s*/, ''); // strip frontmatter
    return md.replace(/\$ARGS/g, args).trim() || null;
  } catch {
    return null;
  }
}

/** One-line statusline: session · branch · tasks · elapsed. */
async function printStatus(session: AgentSession): Promise<void> {
  const r = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    reject: false, cwd: cwd(),
  });
  const branch = r.exitCode === 0 ? r.stdout.trim() : 'no-git';
  const s = session.stats;
  const mins = ((Date.now() - s.startedAt) / 60000).toFixed(0);
  const lastTask = session.lastTask;
  const unverified = lastTask.unverified > 0 ? chalk.yellow(` · ⚠ ${lastTask.unverified} unverified`) : '';
  console.log(
    chalk.dim(`─ ${session.displayName} · ${branch} · ${s.tasks} tasks · ${s.toolCalls} tools · ${mins}m${runningCount() > 0 ? ` · ${runningCount()} shell(s)` : ''}${unverified}`),
  );
}

const HELP = `
${chalk.bold('Slash commands')}
  /help             Show this help
  /clear            Start a brand-new chat (context reset)
  /resume           List saved chats to reconnect to
  /resume <n|name>  Reconnect to old chat by number or name
  /rename <name>    Name this session (shown in /resume list)
  /research <query> Deep research - gathers context for HEAD session
  /skill            List your custom skills
  /skill <idea>     Create an elite expert skill (5-phase pipeline; run it as /<name> <request>)
  /skill update <name> <changes>  Refine one of your skills
  /skill delete <name>  Delete a skill
  /mcp              List MCP tool packs (10 built-ins install on first use)
  /mcp <idea>       Build a custom MCP tool pack with AI
  /mcp enable|disable <name>  Turn a pack on/off · /mcp delete <name> removes it
  /image <path>     Attach an image to your NEXT message
  /paste            Paste clipboard image (or press Alt+V)
  /fork [name]      Branch this conversation into a new chat (original kept)
  /rewind [n]       Undo the last n file changes (default 1; /undo works too)
  /shells           List background shells the agent started (/kill <name> stops one)
  /diff             Show git status + changed files at a glance
  /compact          Summarize session, continue in a fresh chat (fixes slow/confused long chats)
  /sessions         Same as /resume with no argument
  /stats            Session statistics
  /exit             Quit (Ctrl+C twice also works)

${chalk.bold('Typical workflow')}
  1. /research "topic" - gather context
  2. Regular prompt - HEAD agent codes based on research
  3. Repeat as needed

${chalk.dim('Custom commands: .freegent/commands/<name>.md becomes /<name> ($ARGS supported)')}
`;



/** Print the bottom rule after a submitted input line. */
export function closeInputBox(_line: string): void {
  if (!process.stdout.isTTY) return;
  const cols = process.stdout.columns ?? 80;
  readline.clearLine(process.stdout, 0);
  process.stdout.write(chalk.dim('─'.repeat(cols)) + '\n');
}

/** Claude Code rule-style prompt: top rule with label, input row, bottom rule. */
function prompt(rl: readline.Interface, note = ''): void {
  if (!process.stdout.isTTY) {
    rl.setPrompt(chalk.bold.blueBright('❯ '));
    rl.prompt();
    return;
  }
  const cols = process.stdout.columns ?? 80;
  const label = note ? ` freegent · ${note} ──` : ' freegent ──';
  const left = Math.max(0, cols - label.length);
  console.log(chalk.dim('─'.repeat(left) + label));
  console.log('');
  console.log(chalk.dim('─'.repeat(cols)));
  readline.moveCursor(process.stdout, 0, -2);
  rl.setPrompt(chalk.bold.blueBright('❯ '));
  rl.prompt();
}

async function printSessionList(): Promise<void> {
  const sessions = await loadSessions();
  if (sessions.length === 0) {
    console.log(chalk.dim('No saved sessions yet. Finish a task first.'));
    return;
  }
  console.log(chalk.bold('\nSaved chats:'));
  sessions.slice(0, 15).forEach((s, i) => {
    const when = s.lastUsedAt.slice(0, 16).replace('T', ' ');
    console.log(
      `  ${chalk.blueBright(String(i + 1).padStart(2))}. ${chalk.white(s.name)} ` +
        chalk.dim(`(${when}, ${s.cwd})`),
    );
  });
  console.log(chalk.dim('\nUse /resume <number or name> to reconnect.\n'));
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Interactive Claude Code style REPL. */
export async function startRepl(initialTask?: string): Promise<void> {
  printBanner(cwd());
  const session = new AgentSession();
  await session.start();

  // Bracketed paste: terminal wraps pastes in ESC[200~ ... ESC[201~. We
  // intercept those chunks BEFORE readline, store the text, and inject a
  // one-line placeholder chip so the input box never gets shredded.
  const pasteHandler = new PasteHandler();
  const filtered = new PassThrough();
  let pasting = false;
  let pasteAcc = '';
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); // we read stdin ourselves; readline sees `filtered`
    process.stdout.write('\x1b[?2004h'); // enable bracketed paste
  }
  process.stdin.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    // Belt-and-suspenders: directly cancel when Ctrl+C arrives during a task,
    // in case readline's SIGINT emission is delayed by spinner stdout writes.
    // Ctrl+C can arrive in a larger stdin chunk (especially while a tool is
    // printing or the terminal is buffering). Detect it by containment rather
    // than requiring the entire chunk to equal exactly one byte.
    if (raw.includes('\x03') && busy) {
      if (!interrupting) {
        interrupting = true;
        session.cancel();
        console.log(chalk.yellow('\nInterrupting task... (killing running command)'));
      }
    }
    let chunk = raw.replaceAll('\x03', '');
    while (chunk.length > 0) {
      if (pasting) {
        const end = chunk.indexOf(PASTE_END);
        if (end === -1) { pasteAcc += chunk; return; }
        pasteAcc += chunk.slice(0, end);
        chunk = chunk.slice(end + PASTE_END.length);
        pasting = false;
        const clean = pasteAcc.replace(/\r\n?/g, '\n');
        pasteAcc = '';
        if (clean.includes('\n')) {
          filtered.write(pasteHandler.add(clean));
        } else {
          filtered.write(clean); // single-line paste behaves like typing
        }
      } else {
        const start = chunk.indexOf(PASTE_START);
        if (start === -1) { filtered.write(chunk); return; }
        filtered.write(chunk.slice(0, start));
        chunk = chunk.slice(start + PASTE_START.length);
        pasting = true;
      }
    }
  });
  process.stdin.resume();

  /** Replace [paste#N: ...] chips with their stored full text. */
  const expandPastes = (line: string): string => pasteHandler.expand(line);

  const rl = readline.createInterface({ input: filtered, output: process.stdout, terminal: true });
  // Route confirm() prompts through THIS SAME readline interface instead of
  // letting it create its own on raw process.stdin - two readline interfaces
  // fighting over stdin (one filtered+raw-mode-owning here, one naive) is
  // what broke typing/Ctrl+C after any prompt during a task.
  setConfirmHandler((question) => {
    const wasSpinning = pauseActiveSpinnerForPrompt();
    return new Promise<boolean>((resolve) => {
      rl.question(chalk.yellow(`\n? ${question} `) + chalk.dim('(y/N) '), (answer) => {
        resumeActiveSpinnerAfterPrompt(wasSpinning);
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'y' || normalized === 'yes');
      });
    });
  });
  let busy = false;
  let sigints = 0;
  let closed = false;

  // Readline's refresh (on prompt AND on every keypress) clears everything
  // right of the cursor and below - erasing the box's right wall and bottom
  // border. Repaint both immediately after each refresh so the frame stays
  // complete at all times.
  const paintFrame = (): void => {
    if (!process.stdout.isTTY || busy || closed) return;
    const cols = process.stdout.columns ?? 80;
    const esc = '\x1b';
    // Repaint the bottom rule line below the cursor (readline's refresh erases it).
    const seq = `${esc}7${esc}[1B${esc}[1G${esc}[2m${'─'.repeat(cols)}${esc}[22m${esc}8`;
    process.stdout.write(seq);
  };
  (filtered as NodeJS.EventEmitter).on('keypress', (_s: unknown, key?: { name?: string }) => {
    // Enter moves to a new row - painting there would leave stray borders.
    if (key?.name === 'return' || key?.name === 'enter') return;
    paintFrame();
  });

  const safePrompt = (): void => {
    if (closed) return;
    const pending = pasteHandler.count() > 0 && !busy ? `${pasteHandler.count()} paste chip(s)` : '';
    prompt(rl, pending);
    paintFrame(); // rl.prompt() clears below the cursor - restore the frame
  };

  // Alt+V: paste clipboard image, like Claude Code.
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (_str, key: { name?: string; meta?: boolean } | undefined) => {
    if (!key || busy) return;
    if (key.meta && key.name === 'v') {
      void (async () => {
        const saved = await saveClipboardImage();
        if (!saved) {
          console.log(chalk.red('\nNo image found in clipboard.'));
        } else {
          try {
            await session.queueImage(saved);
            console.log(chalk.green('\n✔'), `Pasted image queued (${saved}) — attaches to your next message.`);
          } catch {
            console.log(chalk.red('\nFailed to queue pasted image.'));
          }
        }
        safePrompt();
      })();
    }
  });

  // Ctrl+O: expand the last collapsed code block (Claude Code style).
  process.stdin.on('keypress', (_str, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (!key || key.name !== 'o' || !key.ctrl) return;
    const code = getLastCollapsed();
    if (!code) { console.log(chalk.dim('\n(no code block to expand)')); safePrompt(); return; }
    console.log('');
    code.split('\n').forEach(l => console.log(chalk.white(l)));
    console.log('');
    safePrompt();
  });

  const VERBS = ['Worked', 'Brewed', 'Baked', 'Cooked', 'Cogitated', 'Churned',
    'Crunched', 'Simmered', 'Pondered', 'Forged', 'Noodled', 'Tinkered'];
  const fmtDuration = (ms: number): string => {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  const runTask = async (task: string, useBossMode = false): Promise<void> => {
    busy = true;
    const t0 = Date.now();
    try {
      let summary = '';
      if (useBossMode) {
        // Default: boss mode orchestration
        const result = await runBossMode(session, task);
        summary = result.summary;
      } else {
        // Regular task mode
        summary = await session.runTask(task);
      }
      const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
      console.log(chalk.blueBright('\n●'), chalk.white(summary));
      const tokTotal = session.stats.tokensUsed;
      const tokStr = tokTotal < 1000 ? `${tokTotal}` : `${(tokTotal / 1000).toFixed(1)}k`;
      const tokens = tokTotal > 0 ? chalk.dim(` · ↓ ${tokStr} tokens`) : '';
      const tools = session.lastTask.toolCalls > 0 ? chalk.dim(` · ${session.lastTask.toolCalls} tool${session.lastTask.toolCalls === 1 ? '' : 's'}`) : '';
      const files = session.lastTask.filesChanged > 0 ? chalk.dim(` · ${session.lastTask.filesChanged} file${session.lastTask.filesChanged === 1 ? '' : 's'}`) : '';
      console.log(chalk.blue(`\n✻ ${verb} for ${fmtDuration(Date.now() - t0)}`) + tokens + tools + files);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'interrupted') {
        console.log(chalk.yellow('■ Task cancelled.'), chalk.dim('Type a new task to continue.'));
      } else {
        logger.error(msg);
      }
    } finally {
      busy = false;
      sigints = 0;
      interrupting = false;
      rl.resume(); // ensure readline accepts input after spinner activity
      await printStatus(session).catch(() => undefined);
      safePrompt();
    }
  };

  const shutdown = async (): Promise<void> => {
    closed = true;
    stopAllShells();
    if (process.stdin.isTTY) process.stdout.write('\x1b[?2004l'); // disable bracketed paste
    rl.close();
    await session.close();
    console.log(chalk.dim('Goodbye.'));
    process.exit(0);
  };

  let interrupting = false;
  rl.on('SIGINT', () => {
    if (busy) {
      // Claude-style: first Ctrl+C only cancels the running task, never exits.
      session.cancel();
      if (!interrupting) {
        interrupting = true;
        console.log(chalk.yellow('\nInterrupting task... (killing running command)'));
      }
      sigints = 0;
      return;
    }
    sigints++;
    if (sigints >= 2) return void shutdown();
    console.log(chalk.dim('\nPress Ctrl+C again to exit, or keep typing.'));
    safePrompt();
  });

  /** Run a multi-phase skill pipeline with busy-state handling. */
  const runPipeline = async (fn: () => Promise<string>): Promise<void> => {
    busy = true;
    try {
      const summary = await fn();
      console.log(chalk.blueBright('\n●'), chalk.white(summary));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "interrupted") console.log(chalk.yellow("■ Pipeline cancelled."));
      else logger.error(msg);
    } finally {
      busy = false; rl.resume();
      await printStatus(session).catch(() => undefined);
      safePrompt();
    }
  };

  const handleSlash = async (input: string, silent = false): Promise<void> => {
    const [cmd, ...restParts] = input.split(/\s+/);
    const rest = restParts.join(' ').trim();
    switch (cmd) {
      case '/exit':
      case '/quit':
        return void shutdown();
      case '/help':
        console.log(HELP);
        break;
      case '/clear':
        await session.newChat();
        await clearMemory();
        clearTodos();
        console.log(chalk.dim('Started a fresh chat. Context reset.'));
        break;
      case '/fork':
        await session.fork(rest || undefined);
        console.log(chalk.green('✔'), `Forked into "${session.displayName}" — original saved in /resume.`);
        break;
      case '/compact': {
        busy = true;
        try {
          console.log(chalk.dim('Summarizing session and starting a fresh chat...'));
          await session.compact();
          console.log(chalk.green('✔'), 'Context compacted — continue where you left off in a fresh chat.');
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
        } finally {
          busy = false;
        }
        break;
      }
      case '/shells': {
        const all = listShells();
        if (all.length === 0) { console.log(chalk.dim('No background shells.')); break; }
        for (const s of all) {
          const state = s.exited ? chalk.red(`exited ${s.exitCode}`) : chalk.green('running');
          console.log(`  ${chalk.cyan(s.id)} ${chalk.white(s.name)} [${state}] ${chalk.dim(s.command)}`);
        }
        console.log(chalk.dim('  /shells kill <id|name> to stop one.'));
        break;
      }
      case '/shells kill':
      case '/kill': {
        if (!rest) { console.log(chalk.red('Usage: /kill <shell id or name>')); break; }
        console.log(stopShell(rest) ? chalk.yellow(`Stopped ${rest}.`) : chalk.red(`No shell ${rest}.`));
        break;
      }
      case '/diff': {
        const r = await execa('git', ['diff', '--stat'], { cwd: cwd(), reject: false });
        const u = await execa('git', ['status', '--short'], { cwd: cwd(), reject: false });
        if (r.exitCode !== 0) console.log(chalk.dim('Not a git repository.'));
        else {
          console.log(u.stdout ? chalk.white(u.stdout) : chalk.dim('Working tree clean.'));
          if (r.stdout) console.log(chalk.dim(r.stdout));
        }
        break;
      }
      case '/skill': {
        if (!rest) { await listSkills(); break; }
        const del = /^(?:delete|remove)\s+(\S+)\s*$/.exec(rest);
        if (del) {
          const gone = await deleteSkill(del[1].replace(/^\//, ''));
          console.log(gone
            ? chalk.yellow(`✔ Deleted skill /${del[1].replace(/^\//, '')} (${gone})`)
            : chalk.red(`No skill named ${del[1]}. /skill to list.`));
          break;
        }
        const m = /^update\s+(\S+)\s+([\s\S]+)$/.exec(rest);
        if (m) {
          if ((await readSkill(m[1])) === null) {
            console.log(chalk.red(`No skill named ${m[1]}. /skill to list.`));
            break;
          }
          void runPipeline(() => runSkillUpdate(session, m[1], m[2]));
          return;
        }
        void runPipeline(() => runSkillCreate(session, rest));
        return;
      }
      case '/mcp': {
        if (!rest) { printMcpList(await listMcps()); break; }
        const tog = /^(enable|disable)\s+(\S+)\s*$/.exec(rest);
        if (tog) {
          const on = tog[1] === 'enable';
          const ok = await setMcpEnabled(tog[2], on);
          console.log(ok
            ? chalk.green(`✔ MCP ${tog[2]} ${on ? 'enabled' : 'disabled'}.`)
            : chalk.red(`No MCP named ${tog[2]}. /mcp to list.`));
          break;
        }
        const delM = /^(?:delete|remove)\s+(\S+)\s*$/.exec(rest);
        if (delM) {
          const gone = await deleteMcp(delM[1]);
          console.log(gone
            ? chalk.yellow(`✔ Deleted MCP ${delM[1]} (${gone})`)
            : chalk.red(`No MCP named ${delM[1]}. /mcp to list.`));
          break;
        }
        void runPipeline(() => runMcpCreate(session, rest));
        return;
      }
      case '/task': {
        if (!rest) { console.log(chalk.red('Usage: /task <side task prompt>')); break; }
        busy = true;
        try {
          const summary = await session.runSideTask(rest);
          console.log(chalk.green('\n✔ Side task done:'), chalk.white(summary), '\n');
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
        } finally {
          busy = false;
        }
        break;
      }
      case '/undo':
      case '/rewind': {
        const n = Math.max(1, Number(rest) || 1);
        const results = await rewind(n);
        for (const line of results) console.log(chalk.yellow('↩'), line);
        break;
      }
      case '/sessions':
        await printSessionList();
        break;
      case '/resume': {
        if (!rest) { await printSessionList(); break; }
        const target = await findSession(rest);
        if (!target) { console.log(chalk.red(`No saved chat matches "${rest}".`)); break; }
        await session.resume(target);
        console.log(chalk.green('✔'), `Resumed "${target.name}" — continue where you left off.`);
        break;
      }
      case '/rename':
        if (!rest) { console.log(chalk.red('Usage: /rename <new name>')); break; }
        await session.rename(rest);
        console.log(chalk.green('✔'), `Session renamed to "${rest}".`);
        break;
      case '/paste': {
        const saved = await saveClipboardImage();
        if (!saved) { console.log(chalk.red('No image found in clipboard.')); break; }
        await session.queueImage(saved);
        console.log(chalk.green('✔'), `Pasted image queued — attaches to your next message.`);
        break;
      }
      case '/image': {
        if (!rest) { console.log(chalk.red('Usage: /image <path-to-image>')); break; }
        try {
          const abs = await session.queueImage(rest);
          console.log(chalk.green('✔'), `Queued ${abs} — it will be attached to your next message.`);
        } catch {
          console.log(chalk.red(`File not found: ${rest}`));
        }
        break;
      }
      case '/stats': {
        const s = session.stats;
        const mins = ((Date.now() - s.startedAt) / 60000).toFixed(1);
        console.log(`\n  version  v${VERSION}\n  uptime   ${mins} min\n  tasks    ${s.tasks}\n  tools    ${s.toolCalls}\n`);
        break;
      }
      case '/research': {
        if (!rest) console.log(chalk.yellow('Usage: /research <query>'));
        else { busy = true; try { const r = await runResearch(session, rest); console.log(r); } catch(e) { logger.error((e as Error).message); } finally { busy = false; rl.resume(); printStatus(session).catch(() => undefined); safePrompt(); } }
        break;
      }
      case '/boss': {
        if (!rest) console.log(chalk.yellow('Usage: /boss <task>'));
        else { busy = true; try { const r = await runBossMode(session, rest); console.log(r.summary); } catch(e) { logger.error((e as Error).message); } finally { busy = false; rl.resume(); printStatus(session).catch(() => undefined); safePrompt(); } }
        break;
      }
      default: {
        // User-made skill: .freegent/skills/<name>.md - runs as a pipeline
        if ((await readSkill(cmd.slice(1))) !== null) {
          if (!rest) { console.log(chalk.red(`Usage: ${cmd} <your request>`)); break; }
          void runPipeline(() => runSkillPipeline(session, cmd.slice(1), rest));
          return;
        }
        // Custom command: .freegent/commands/<name>.md
        const custom = await loadCustomCommand(cmd.slice(1), rest);
        if (custom) {
          void runTask(custom);
          return;
        }
        console.log(chalk.red(`Unknown command ${cmd}.`), chalk.dim('Try /help'));
      }
    }
    if (!silent) safePrompt();
  };

  rl.on('line', (line) => {
    sigints = 0;
    if (busy) return;
    closeInputBox(line);
    const expanded = expandPastes(line).trim();
    pasteHandler.clear(); // chips consumed (or abandoned) once the line is sent
    if (!expanded) return safePrompt();

    // Support multiple commands in one line: /cmd1 arg1 /cmd2 arg2
    // A chip that survives expansion means its paste text was lost - sending
    // the literal "[paste#1: 2 lines]" downstream wastes a whole pipeline run.
    if (/\[paste#\d+: \d+ lines\]/.test(expanded)) {
      console.log(chalk.red('Paste content was lost - please paste the text again and resend.'));
      return safePrompt();
    }

    // Slash command with multiline args (e.g. /skill + pasted description):
    // run it directly - the parallel split below is single-line only.
    if (expanded.startsWith('/') && expanded.includes('\n')) {
      return void handleSlash(expanded);
    }
    if (expanded.startsWith('/') && !expanded.includes('\n')) {
      const parts = expanded.split(/(?=\/[a-z])/);
      const commands = parts.map(p => p.trim()).filter(p => p.length > 0);

      if (commands.length > 1) {
        // Multiple commands: run in parallel
        console.log(chalk.dim(`\n  (running ${commands.length} commands in parallel)`));
        busy = true;
        (async () => {
          try {
            await Promise.all(commands.map(cmd => handleSlash(cmd, true)));
          } finally {
            busy = false;
            rl.resume();
            await printStatus(session).catch(() => undefined);
            safePrompt();
          }
        })();
        return;
      }
      return void handleSlash(expanded);
    }
    const lines = expanded.split('\n').length;
    if (lines > 1) console.log(chalk.dim(`  (sending ${lines}-line prompt)`));
    void runTask(expanded);
  });

  if (initialTask) await runTask(initialTask);
  else safePrompt();
}