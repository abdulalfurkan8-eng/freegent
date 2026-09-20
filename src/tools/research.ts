import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/**
 * Agent-invoked research: the model calls this MID-TASK whenever it needs
 * outside knowledge - market examples, GitHub patterns, docs, deep dives.
 * Runs a researcher in its own background tab (ctx.spawn), so the main
 * conversation keeps its context. Callable as many times as needed.
 */
const FOCUS: Record<string, string> = {
  market:
    'Find the 3-5 BEST live websites in this market. web_fetch each one: the ' +
    'homepage AND the main inner pages (product, pricing, about, docs, ...). ' +
    'Report per site: page inventory, layout, nav, colour palette, typography, ' +
    'user flow, and what makes it feel premium instead of generic.',
  github:
    'Find the best GitHub repositories for this. web_fetch repo pages, READMEs ' +
    'and key source files. Report: which repos, how they structure the code, ' +
    'patterns worth copying, exact URLs.',
  docs:
    'Find and web_fetch the official documentation pages that answer this. ' +
    'Report exact answers with quotes and links - not vague summaries.',
  deep:
    'Full deep dive: web_fetch 8+ real pages across live sites, official docs, ' +
    'GitHub and quality articles. Extract concrete facts with quotes, note ' +
    'where sources disagree, and end with clear recommendations.',
};

export async function researchTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.spawn) return fail('research: not available in this context.');
  const query = String(call.query ?? '').trim();
  if (!query) return fail('research: "query" is required.');
  const focus = String(call.focus ?? 'deep').toLowerCase().trim();
  const guide = FOCUS[focus] ?? FOCUS.deep;

  const task =
    `RESEARCH (${focus}): ${query}\n\n${guide}\n\n` +
    'Rules: actually web_fetch real URLs - a failed fetch (HTTP error/empty ' +
    'page) does NOT count, move to the next site. Never cite Reddit/Quora/' +
    'YouTube. Do NOT write or edit any files. Your finish summary IS the ' +
    'deliverable - put the FULL findings there, organised and specific.';

  const results = await ctx.spawn([{ label: `research:${focus}`, task }]);
  const r = results[0];
  if (!r || !r.ok) return fail(`research failed: ${r?.output ?? 'no result'}`);
  return ok(
    `RESEARCH FINDINGS (${focus}) for "${query}":\n\n${r.output}\n\n` +
    'Apply these findings. Call research again with a sharper query or a ' +
    'different focus (market|github|docs|deep) if you need more.',
  );
}