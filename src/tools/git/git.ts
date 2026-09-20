import { execa } from 'execa';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

async function run(cmd: string, args: string[], cwd: string): Promise<ToolResult> {
  const r = await execa(cmd, args, { cwd, reject: false });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
  return r.exitCode === 0 ? ok(out || '(no output)') : fail(out || `${cmd} error`);
}

/** Run common git actions, including a full PR flow via the gh CLI. */
export async function gitTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = String(call.action ?? '');
  switch (action) {
    case 'status':
      return run('git', ['status', '--short', '--branch'], ctx.cwd);
    case 'diff':
      return run('git', ['diff', '--stat'], ctx.cwd);
    case 'log':
      return run('git', ['log', '--oneline', '-n', '15'], ctx.cwd);
    case 'commit': {
      const message = String(call.message ?? '').trim();
      if (!message) return fail('git commit: "message" is required');
      await run('git', ['add', '-A'], ctx.cwd);
      return run('git', ['commit', '-m', message], ctx.cwd);
    }
    case 'pr': {
      // branch -> commit -> push -> PR, in one action (requires gh CLI).
      const message = String(call.message ?? '').trim() || 'freegent changes';
      const branch = String(call.branch ?? '').trim();
      if (branch) await run('git', ['checkout', '-b', branch], ctx.cwd);
      await run('git', ['add', '-A'], ctx.cwd);
      await run('git', ['commit', '-m', message], ctx.cwd);
      const push = await run('git', ['push', '-u', 'origin', 'HEAD'], ctx.cwd);
      if (!push.ok) return push;
      return run('gh', ['pr', 'create', '--fill'], ctx.cwd);
    }
    default:
      return fail(`git: unknown action "${action}" (status|diff|log|commit|pr)`);
  }
}