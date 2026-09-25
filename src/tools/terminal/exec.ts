import { execa } from 'execa';
import { spawn } from 'node:child_process';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';
import { confirm } from '../../utils/confirm.js';
import { logger } from '../../utils/logger.js';
import { startCommandTimer } from '../../utils/render.js';
import { DEFAULTS } from '../../config/defaults.js';
import { readFile as readTextFile } from 'node:fs/promises';

const DANGEROUS = [
  /\brm\s+-rf?\b/, /\bmkfs\b/, /\b:\(\)\s*\{/, /\bdd\s+if=/,
  /\bgit\s+push\b.*--force/, /\bshutdown\b/, /\breboot\b/,
  /\bformat\b/, />\s*\/dev\/sd/,
  /taskkill.+(node|freegent)/i, // would kill freegent itself
];

/** Commands that open a GUI/server and never exit on their own. */
const LONG_RUNNING = [
  /\bnpm\s+(run\s+)?start\b/, /\belectron\b/, /\bnpm\s+run\s+dev\b/,
  /\bvite\b(?!\s+build)/, /\bnext\s+dev\b/, /\bnodemon\b/,
  /\bserve\b/, /\bhttp-server\b/, /^start\s/i,
  // GUI/server Python apps: sample them too (but not python -c probes).
  /python3?\s+(?!-c\s)\S+\.py\s*$/,
  /flask\s+run/, /uvicorn/, /streamlit\s+run/,
  /(npx[ ]+)?tsx[ ]+(watch[ ]+)?[A-Za-z0-9_./-]+[.]ts/, /ts-node[ ]+/,
  /node[ ]+[A-Za-z0-9_./-]*(server|index|app|main)[.](js|mjs)/,
];

/** Hard ceiling for any foreground command, no matter what the model asks for. */
const MAX_TIMEOUT_MS = DEFAULTS.terminal.maxTimeoutMs; // 10 minutes
/** Used when the model doesn't specify a `timeout` header. */
const DEFAULT_TIMEOUT_MS = DEFAULTS.terminal.defaultTimeoutMs; // 1 minute

function isDangerous(cmd: string): boolean {
  return DANGEROUS.some((re) => re.test(cmd));
}

function isLongRunning(cmd: string): boolean {
  return LONG_RUNNING.some((re) => re.test(cmd));
}
/** Windows GUI executables must not be awaited by the agent. Their lifetime
 * belongs to the desktop, not the terminal tool. Waiting on one can make the
 * whole task appear frozen and can prevent a clean Ctrl+C cancellation path. */

/** Application-automation commands that violate an explicit "mouse/keyboard, no script"
 * request. These are blocked at runtime even if the model tries to substitute a
 * Blender/Maya/Office/browser script after GUI tools fail. */
const APPLICATION_SCRIPT_AUTOMATION = [
  /\bblender(?:\.exe)?\b[^\r\n]*(?:--python|--background[^\r\n]*--python|\-\-python-expr)/i,
  /\bblender(?:\.exe)?\b[^\r\n]*\bpython\b[^\r\n]*\.(?:py)\b/i,
  /\b(?:maya|houdini|3dsmax|maxscript|unity|unreal(?:editor)?)\b[^\r\n]*(?:-script|-executeMethod|python|\.py\b)/i,
  /\b(?:python|python3)\b[^\r\n]*\b(?:bpy|pyautogui|selenium|playwright|win32com)\b/i,
  /\b(?:powershell|pwsh)\b[^\r\n]*(?:-command|-file)[^\r\n]*(?:blender|bpy|pyautogui|selenium|playwright|win32com)\b/i,
];

export function isApplicationScriptAutomationCommand(command: string): boolean {
  return APPLICATION_SCRIPT_AUTOMATION.some((re) => re.test(command));
}

const WINDOWS_GUI_LAUNCH = [
  /\bblender(?:\.exe)?\b/i,
  /\bnotepad(?:\.exe)?\b/i,
  /\bcalc(?:ulator)?(?:\.exe)?\b/i,
  /\bmspaint(?:\.exe)?\b/i,
  /\bcode(?:\.exe)?\b/i,
  /\bexplorer(?:\.exe)?\b/i,
  /\bchrome(?:\.exe)?\b/i,
  /\bmsedge(?:\.exe)?\b/i,
  /\bfirefox(?:\.exe)?\b/i,
  /\bwhatsapp(?:\.exe)?\b/i,
];

export function isDetachedGuiLaunchCommand(cmd: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && WINDOWS_GUI_LAUNCH.some((re) => re.test(cmd));
}

function launchDetachedGui(cmd: string, cwd: string): number | undefined {
  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

/**
 * Parse a `timeout` header into milliseconds. Accepts plain numbers
 * (seconds), "Ns", "Nm", or "Nms". Always clamped to [1s, MAX_TIMEOUT_MS] -
 * the model can ask for anything, it just can never exceed the 10m ceiling.
 */
function parseTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TIMEOUT_MS;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
  if (!m) return DEFAULT_TIMEOUT_MS;
  const value = parseFloat(m[1]);
  const unit = m[2] ?? 's';
  const ms = unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1_000;
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(ms, 1_000), MAX_TIMEOUT_MS);
}

/**
 * Execute a shell command. Long-running commands (dev servers, Electron,
 * `npm start`) are auto-promoted to a PERSISTENT background shell (see
 * shells.ts) instead of being timed here.
 *
 * Everything else runs with a TIMER: the model may set `timeout` (seconds,
 * or "Ns"/"Nm") to decide how long a command gets - anywhere from a few
 * seconds up to a hard ceiling of 10 minutes (MAX_TIMEOUT_MS). If it doesn't
 * specify one, DEFAULT_TIMEOUT_MS (1m) applies. The command is killed the
 * moment it's exceeded, so a stuck/interactive command can never hang the
 * agent loop indefinitely.
 *
 * `manual: "true"` skips execution entirely and just hands the command back
 * so the user can copy/paste and run it themselves - the right choice for
 * interactive commands, anything needing credentials, and jobs that would
 * outlast the timeout rather than making the agent loop wait on them.
 */
export async function runCommandTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = String(call.command ?? '');
  if (!command) return fail('run_command: "command" is required');

  const manual = String(call.manual ?? '').toLowerCase() === 'true';

  if (ctx.computerControlOnly && isApplicationScriptAutomationCommand(command)) {
    return fail('BLOCKED: this task explicitly requires mouse/keyboard computer control. Application scripting is disabled for this task. Use windows/computer/screen tools to operate the visible app.');
  }
  if (manual) {
    logger.tool('run_command', `${command}  [-> manual, not executed]`);
    return ok(
      `Not run automatically (manual mode). Copy/paste this yourself:\n\n  ${command}\n`,
    );
  }

  if (ctx.confirmCommands || isDangerous(command)) {
    logger.warn(`AI wants to run: ${command}`);
    const approved = await confirm(`Run this command?`);
    if (!approved) return ok(`User declined to run: ${command}`);
  }

  // GUI launch? Detach it immediately. A desktop application's lifetime is
  // independent from this terminal tool, so awaiting its process would stall
  // the agent until timeout (and historically made Ctrl+C look broken).
  if (isDetachedGuiLaunchCommand(command)) {
    const pid = launchDetachedGui(command, ctx.cwd);
    logger.tool('run_command', `${command}  [-> detached GUI${pid ? ` pid ${pid}` : ''}]`);
    return ok(`Launched GUI application in background${pid ? ` (pid ${pid})` : ''}.`);
  }

  // Server/dev/watch command? Auto-promote to a PERSISTENT background shell
  // instead of sampling-then-killing it. This keeps the process ALIVE so the
  // next curl/test_page actually reaches it - no matter which tool the model
  // reached for.
  if (isLongRunning(command)) {
    const { startShell, runningCount, startupReport } = await import('./shells.js');
    const shell = startShell(command, '', ctx.cwd);
    logger.tool('run_command', `${command}  [-> background shell ${shell.id}]`);
    const report = await startupReport(shell);
    if (shell.exited) {
      return fail(`Started "${command}" but it ${report}`);
    }
    return ok(
      `Started "${command}" as background shell "${shell.id}" - it STAYS RUNNING ` +
        `(now ${runningCount()} shell(s) alive). Do NOT re-run it; use ` +
        `{"tool":"shell","action":"log","name":"${shell.id}"} for more output. ${report}`,
    );
  }

  const timeoutMs = parseTimeoutMs(call.timeout);
  logger.tool('run_command', `${command}  [timeout ${Math.round(timeoutMs / 1000)}s]`);

  const child = execa(command, {
    cwd: ctx.cwd,
    shell: true,
    reject: false,
    all: true,
  });
  const killTree = (): void => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      void execa('taskkill', ['/pid', String(child.pid), '/T', '/F'], { reject: false });
    } else {
      child.kill('SIGKILL');
    }
  };
  const onAbort = () => killTree();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  // Enforce the timeout ourselves with the SAME tree-kill used for user
  // cancellation, instead of execa's own `timeout` option: on Windows with
  // shell:true, execa's built-in timeout only signals the cmd.exe wrapper -
  // it does not kill the wrapper's children, so the real work (e.g. a
  // python.exe grandchild) survives as an orphan and keeps running past the
  // supposed timeout, invisible to the agent.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);

  const stopTimer = startCommandTimer(command, timeoutMs);
  try {
    const result = await child;
    stopTimer();
    clearTimeout(timeoutHandle);
    if (ctx.signal?.aborted) return fail('Command killed: task interrupted by user.');
    const out = (result.all ?? '').toString().slice(0, 12_000);
    const parts = [`exit code: ${result.exitCode}`];
    if (timedOut) {
      parts.push(
        `[stopped automatically after ${Math.round(timeoutMs / 1000)}s timeout - ` +
          `command was still running. Re-run with a longer "timeout" (max 600s/10m), ` +
          `or use manual: "true" to run it yourself outside the agent.]`,
      );
    }
    if (out) parts.push(`output:\n${out}`);
    const output = parts.join('\n');
    return result.exitCode === 0 && !timedOut ? ok(output) : fail(output);
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (ctx.signal?.aborted) return fail('Command killed: task interrupted by user.');
    return fail(`run_command failed: ${(err as Error).message}`);
  } finally {
    stopTimer();
    clearTimeout(timeoutHandle);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}
/**
 * Quick test check after mutations: run relevant tests by file pattern.
 * Returns null if tests pass or can't be run, otherwise the test error.
 */
export async function detectTestCommand(cwd = process.cwd(), changedFile = ''): Promise<string | null> {
  const pkg = await readTextFile(`${cwd}/package.json`, 'utf8').catch(() => '');
  if (pkg) { try { const j=JSON.parse(pkg) as {scripts?:Record<string,string>;devDependencies?:Record<string,string>;dependencies?:Record<string,string>}; const t=j.scripts?.test; if(t) return changedFile ? `npm test -- --testPathPattern="${changedFile}"` : 'npm test'; const deps={...j.dependencies,...j.devDependencies}; if(deps.vitest) return `npx vitest run${changedFile ? ` ${changedFile}` : ''}`; if(deps.jest) return `npx jest${changedFile ? ` ${changedFile}` : ''}`; } catch { /* inspect other manifests */ } }
  const cargo=await readTextFile(`${cwd}/Cargo.toml`,'utf8').catch(()=> ''); if(cargo) return 'cargo test';
  const py=await readTextFile(`${cwd}/pyproject.toml`,'utf8').catch(()=> ''); if(py) { if(/pytest/i.test(py)) return `pytest${changedFile ? ` ${changedFile}` : ''}`; if(/unittest/i.test(py)) return 'python -m unittest'; }
  const req=await readTextFile(`${cwd}/pytest.ini`,'utf8').catch(()=> ''); if(req) return `pytest${changedFile ? ` ${changedFile}` : ''}`;
  if (changedFile.endsWith('.go')) return 'go test ./...';
  if (changedFile.endsWith('.rs')) return 'cargo test';
  return null;
}

export async function quickTestCheck(changedFile: string): Promise<string | null> {
  if (!process.stdout.isTTY) return null;
  const cmd = await detectTestCommand(process.cwd(), changedFile);
  if (!cmd) return null;
  const child = execa(cmd, { cwd: process.cwd(), shell: true, reject: false, timeout: 30_000, all: true });
  try { const result = await child; if (result.exitCode === 0) return null; return (result.all ?? '').toString().split('\n').slice(0, 12).join('\n'); }
  catch { return null; }
}
