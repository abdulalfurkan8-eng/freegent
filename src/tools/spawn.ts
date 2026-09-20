import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

const MAX_JOBS = 3;

/**
 * Delegate independent sub-tasks to agents running in their own browser tabs.
 *   tool: spawn
 *   jobs: build the API | write the tests | write the README
 * Jobs run at the SAME time, so they must not touch the same files.
 */
export async function spawnTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.spawn) return fail('spawn: not available in this context.');

  const raw = call.jobs ?? call.tasks;
  const list = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split('|'))
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.length === 0) {
    return fail('spawn: "jobs" is required — separate independent sub-tasks with "|".');
  }
  if (list.length > MAX_JOBS) {
    return fail(`spawn: at most ${MAX_JOBS} jobs at once (got ${list.length}). Group them.`);
  }
  if (list.length === 1) {
    return fail('spawn: only worth it for 2+ INDEPENDENT jobs. Do a single job yourself.');
  }

  const results = await ctx.spawn(
    list.map((task, i) => ({ label: `job${i + 1}`, task })),
  );

  const body = results
    .map((r, i) => `### ${r.label} (${r.ok ? 'done' : 'FAILED'})\n${list[i]}\n${r.output}`)
    .join('\n\n');
  const failed = results.filter((r) => !r.ok).length;

  return ok(
    `${results.length} job(s) ran in parallel, ${failed} failed.\n\n${body}\n\n` +
      (failed > 0
        ? 'Redo the failed work yourself before continuing.'
        : 'Review the results — you are still responsible for the final state.'),
  );
}