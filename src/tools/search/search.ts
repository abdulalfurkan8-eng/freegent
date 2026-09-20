import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);
const MAX_HITS = 200;

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Recursively search project files for a regex/text query. */
export async function searchTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(call.query ?? '');
  if (!query) return fail('search: "query" is required');

  const base = resolve(ctx.cwd, String(call.path ?? '.'));
  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const hits: string[] = [];
  try {
    for await (const file of walk(base)) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${relative(ctx.cwd, file)}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= MAX_HITS) break;
        }
      }
      if (hits.length >= MAX_HITS) break;
    }
  } catch (err) {
    return fail(`search: ${(err as Error).message}`);
  }

  if (hits.length === 0) return ok(`No matches for "${query}"`);
  return ok(`${hits.length} match(es):\n${hits.join('\n')}`);
}