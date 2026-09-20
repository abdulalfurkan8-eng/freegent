import { ToolCall, ToolContext, ToolResult, ok, fail, ToolHandler } from './types.js';
import { readFileTool } from './filesystem/read.js';
import { writeFileTool } from './filesystem/write.js';
import { editFileTool } from './filesystem/edit.js';
import { deleteFileTool } from './filesystem/delete.js';
import { listDirTool } from './filesystem/list.js';
import { treeTool, readFilesTool } from './filesystem/batch.js';
import { appendFileTool } from './filesystem/append.js';
import { searchTool } from './search/search.js';
import { runCommandTool } from './terminal/exec.js';
import { gitTool } from './git/git.js';
import { todoTool } from './todo.js';
import { webFetchTool } from './web.js';
import { checkTool } from './check.js';
import { testPageTool } from './testpage.js';
import { screenshotTool } from './screenshot.js';
import { symbolsTool } from './symbols.js';
import { depsTool } from './deps.js';
import { visualTool } from './visual.js';
import { spawnTool } from './spawn.js';
import { shellTool } from './terminal/shells.js';
import { rememberTool } from './remember.js';
import { researchTool } from './research.js';
import { phoneTool } from './phone.js';
import { windowsTool, computerTool } from './windows.js';
import { screenObserveTool } from './screen.js';
import { projectHealthTool } from './health.js';

import { runHooks, isProtected } from '../config/hooks.js';
import { checkpointFile } from '../memory/checkpoints.js';
import { assessRisk } from '../security/permissions.js';
import { isWithinWorkspace } from '../agent/isolation.js';
import { redactSecrets } from '../security/secrets.js';
import { logger } from '../utils/logger.js';
import { chooseGroundTarget } from '../vision/grounding.js';

const HANDLERS: Record<string, ToolHandler> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  append_file: appendFileTool,
  edit_file: editFileTool,
  delete_file: deleteFileTool,
  list_dir: listDirTool,
  tree: treeTool,
  read_files: readFilesTool,
  search: searchTool,
  run_command: runCommandTool,
  git: gitTool,
  todo: todoTool,
  web_fetch: webFetchTool,
  check: checkTool,
  test_page: testPageTool,
  screenshot: screenshotTool,
  symbols: symbolsTool,
  deps: depsTool,
  visual: visualTool,
  spawn: spawnTool,
  shell: shellTool,
  remember: rememberTool,
  research: researchTool,
  phone: phoneTool,
  windows: windowsTool,
  computer: computerTool,
  screen_observe: screenObserveTool,
  project_health: projectHealthTool,
};

export const MUTATING = new Set(['write_file', 'append_file', 'edit_file', 'delete_file']);
export const READ_TOOLS = new Set(['read_file', 'read_files', 'list_dir', 'tree', 'search', 'web_fetch', 'symbols', 'deps', 'project_health']);

/** Auto syntax check after a write. */
async function autoCheck(path: string, ctx: ToolContext): Promise<string | null> {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (/[.](js|mjs|cjs|json|css|html?)$/.test(lower)) {
    const r = await checkTool({ tool: 'check', paths: [path] }, ctx);
    return r.ok ? null : r.output;
  }
  if (lower.endsWith('.py')) {
    const { execa } = await import('execa');
    const r = await execa('python3', ['-m', 'py_compile', path], {
      cwd: ctx.cwd, reject: false, timeout: 15_000,
    }).catch(() => execa('python', ['-m', 'py_compile', path], {
      cwd: ctx.cwd, reject: false, timeout: 15_000,
    }));
    return r.exitCode === 0 ? null : `python syntax error:\n${(r.stderr || '').slice(0, 800)}`;
  }
  return null;
}

export const VERIFYING = new Set(['run_command', 'check', 'test_page', 'screenshot', 'visual', 'phone', 'windows', 'computer', 'screen_observe']);

/** Execute a parsed tool call with guards, safety rails, and hooks. */
export async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  guards?: import('../agent/guards.js').Guards,
): Promise<ToolResult> {
  if (call.tool === 'finish') {
    return ok(String(call.summary ?? 'Task complete.'), true);
  }
  const handler = HANDLERS[call.tool];
  if (!handler) {
    return fail(`Unknown tool "${call.tool}". Valid: ${Object.keys(HANDLERS).join(', ')}, finish`);
  }

  const path = String(call.path ?? '');
  const mutating = MUTATING.has(call.tool);
  const risk = assessRisk(call);
  if (risk.decision === 'deny') return fail(`BLOCKED: ${risk.reason}`);
  if (mutating && path && !(await isWithinWorkspace(ctx.cwd, path))) return fail(`BLOCKED: path is outside the active workspace: ${path}`);
  if (risk.level === 'high') logger.warn(`High-risk tool call: ${call.tool} (${risk.reason})`);

  // Runtime discipline gate (guards).
  if (guards) {
    const { stat } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    let fileExists = false;
    if (path) {
      try { await stat(resolve(ctx.cwd, path)); fileExists = true; } catch { /* new file */ }
    }
    const blocked = guards.gate(call.tool, path, mutating, fileExists);
    if (blocked) return fail(blocked);
    if (call.tool === 'computer' && call.requireGrounding === true && ['click','doubleClick','rightClick','move','drag','scroll'].includes(String(call.action))) {
      const x = Number(call.x ?? (Array.isArray(call.args) ? call.args[0] : NaN));
      const y = Number(call.y ?? (Array.isArray(call.args) ? call.args[1] : NaN));
      const snapshot = ctx.state?.snapshot();
      const stateHash = snapshot?.screen?.hash;
      if (!stateHash) return fail('BLOCKED: requireGrounding=true but no current screen hash is available. Call screen_observe first.');
      const { screenHash: readCurrentScreenHash } = await import('../vision/screen.js');
      const currentHash = await readCurrentScreenHash();
      if (currentHash !== stateHash) return fail('BLOCKED: requireGrounding=true because the desktop changed since the last perception. Re-observe before clicking.');
      const targets = (snapshot?.detectedElements ?? [])
        .filter((e) => e.bbox && typeof e.confidence === 'number')
        .map((e) => ({
          text: e.name, type: e.type, bbox: e.bbox!, confidence: e.confidence!,
          source: 'uia' as const, timestamp: e.timestamp, screenHash: currentHash,
        }));
      const grounded = chooseGroundTarget(targets, '', 10_000, currentHash, 0.45, [x, y]);
      if (!grounded) return fail('BLOCKED: requireGrounding=true but the coordinates are not inside a fresh UI element from the current screen hash. Call screen_observe, then choose a freshly grounded target.');
    }
    if (READ_TOOLS.has(call.tool)) {
      const paths = Array.isArray(call.paths) ? call.paths.map(String) : path ? [path] : [];
      guards.noteRead(paths);
    }
  }

  if (mutating) {
    if (await isProtected(path, ctx.cwd)) {
      return fail(`Blocked: "${path}" is protected by .freegent/hooks.json`);
    }
    const pre = await runHooks('pre', call, ctx.cwd);
    if (pre.blocked) return fail(`Blocked by pre-hook: ${pre.output}`);
    await checkpointFile(ctx.cwd, path).catch((err) => logger.warn(`Checkpoint failed for ${path}: ${(err as Error).message}`));
  }

  let preComputerHash: string | undefined;
  if (call.tool === 'computer' || call.tool === 'windows' && ['focus','launch','close','minimize','maximize','restore','ui_action'].includes(String(call.action))) {
    try {
      const { screenHash } = await import('../vision/screen.js');
      preComputerHash = await screenHash();
    } catch {
      preComputerHash = ctx.state?.snapshot().screen?.hash;
    }
  }

  const result = await handler(call, ctx);

  // Computer-use actions are closed-loop: settle, observe, then run any
  // stronger semantic postcondition available for the specific action.
  // action so the next reasoning turn receives fresh state instead of assuming
  // the click/keypress succeeded. This keeps perception separate from the
  // browser-based LLM transport while making Windows control agentic.
  if (result.ok && (call.tool === 'computer' || (call.tool === 'windows' && ['focus','launch','close','minimize','maximize','restore','ui_action'].includes(String(call.action))))) {
    try {
      const { screenHash, captureScreen } = await import('../vision/screen.js');
      const { settleDesktop, verifyUiAction, foregroundWindow } = await import('../windows/computer.js');
      await settleDesktop(1000).catch(() => undefined);
      const afterHash = await screenHash();
      const changed = preComputerHash ? preComputerHash !== afterHash : true;
      result.output += `\n[postcondition] screenHash=${afterHash.slice(0, 16)} changed=${changed}`;

      if (call.tool === 'windows' && String(call.action) === 'ui_action') {
        const op = String(call.op ?? call.operation ?? call.uiAction ?? 'invoke');
        if (op !== 'getValue') {
          const target = {
            name: typeof call.name === 'string' ? call.name : undefined,
            nameContains: typeof call.nameContains === 'string' ? call.nameContains : undefined,
            automationId: typeof call.automationId === 'string' ? call.automationId : undefined,
            className: typeof call.className === 'string' ? call.className : undefined,
            type: typeof call.type === 'string' ? call.type : undefined,
            index: Number.isFinite(Number(call.index)) ? Number(call.index) : 0,
            window: typeof call.window === 'string' ? call.window : undefined,
            handle: typeof call.handle === 'string' ? call.handle : undefined,
          };
          const verification = await verifyUiAction(op, target, String(call.value ?? call.text ?? ''));
          result.output += `\n[semantic postcondition] ${verification.reason}`;
          if (!verification.ok) { result.ok = false; result.output += '\n[postcondition FAILED]'; }
        }
      } else if (call.tool === 'windows' && String(call.action) === 'focus') {
        const query = String(call.query ?? '').trim().toLowerCase();
        const active = await foregroundWindow();
        const focused = !!active && (!!query ? active.title.toLowerCase().includes(query) || active.process.toLowerCase().includes(query) : false);
        result.output += `\n[semantic postcondition] foreground=${active?.title ?? 'none'} matched=${focused}`;
        if (!focused) { result.ok = false; result.output += '\n[postcondition FAILED] focus target is not foreground.'; }
      }

      if (preComputerHash && preComputerHash !== afterHash) {
        const obs = await captureScreen(true);
        ctx.attachImage?.(obs.path);
        ctx.state?.setScreen(obs.width, obs.height, true, obs.hash, obs.path);
        if (obs.ocr.length) result.output += `\n[post-action OCR] ${obs.ocr.slice(0, 40).join(' | ')}`;
      }
    } catch (e) {
      result.output += `\n[post-action observation unavailable] ${(e as Error).message}`;
    }
  }

  if (mutating && result.ok) {
    guards?.noteMutation(path);
    if (call.tool !== 'delete_file') {
      const auto = await autoCheck(path, ctx);
      if (auto) result.output += `\n[auto-check] ${auto}`;
    }
    const post = await runHooks('post', call, ctx.cwd);
    if (post.output) result.output += `\n[hook] ${post.output}`;
    if (post.blocked) logger.warn(`Post-hook reported a block for ${path}: ${post.output}`);
  }

  if (VERIFYING.has(call.tool) && result.ok && guards) {
    const target = String(call.command ?? call.path ?? call.url ?? '').toLowerCase();
    guards.noteVerification(call.tool, target, true);
  }

  if (!result.ok && guards && path) {
    const strikes = guards.noteFailure(path);
    if (strikes >= 2) {
      result.output += `\n[strike ${strikes}/3 on ${path}]`;
    }
  } else if (result.ok && guards && path) {
    guards.clearStrikes(path);
  }

  // Never persist raw credential-like material in logs/journals. Tool output semantics remain unchanged for the live model.
  if (!result.ok || risk.level === 'high') result.output = redactSecrets(result.output);
  return result;
}