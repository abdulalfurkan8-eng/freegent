import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

/** List entries in a directory, marking directories with a trailing slash. */
export async function listDirTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = String(call.path ?? '.');
  const abs = resolve(ctx.cwd, path);
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return ok(`(empty) ${path}`);
    const lines = entries
      .filter((e) => !IGNORED.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return ok(`${path}:\n${lines.join('\n')}`);
  } catch (err) {
    return fail(`list_dir: cannot list ${path}: ${(err as Error).message}`);
  }
}