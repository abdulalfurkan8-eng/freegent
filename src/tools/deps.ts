import { buildDepIndex, searchDeps } from '../memory/deps.js';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/**
 * Look inside installed dependencies instead of guessing their API.
 *   { "tool": "deps" }                      -> list installed deps + versions
 *   { "tool": "deps", "query": "createRoot" } -> grep dep type definitions
 */
export async function depsTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(call.query ?? '').trim();

  if (!query) {
    const deps = await buildDepIndex(ctx.cwd);
    if (deps.length === 0) return ok('No dependencies declared (no package.json or empty deps).');
    const lines = deps.map((d) => `${d.name}@${d.version}`);
    return ok(`${deps.length} dependencies:\n${lines.join('\n')}`);
  }

  const hits = await searchDeps(ctx.cwd, query);
  if (hits.length === 0) {
    return fail(
      `deps: "${query}" not found in installed dependency type definitions. ` +
        'The symbol may be internal, or the package ships no .d.ts. Try web_fetch for its docs.',
    );
  }
  return ok(`${hits.length} match(es) for "${query}" in dependencies:\n${hits.join('\n')}`);
}