import { buildSymbolIndex } from '../memory/symbols.js';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/**
 * Instant symbol lookup: "where is LoginScreen?" without hunting through
 * directories. Index is rebuilt on every call, so it is never stale.
 */
export async function symbolsTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(call.query ?? '').trim().toLowerCase();
  const index = await buildSymbolIndex(ctx.cwd);
  if (index.length === 0) return ok('No symbols found (no recognized source files).');

  const matches = query
    ? index.filter((s) => s.name.toLowerCase().includes(query))
    : index;
  if (matches.length === 0) {
    return fail(`symbols: no symbol matching "${query}" (${index.length} symbols indexed). Try a shorter query or the search tool.`);
  }
  const lines = matches
    .slice(0, 60)
    .map((s) => `${s.name} (${s.kind}) -> ${s.file}`);
  const more = matches.length > 60 ? `\n...and ${matches.length - 60} more - refine the query` : '';
  return ok(`${matches.length} match(es):\n${lines.join('\n')}${more}`);
}