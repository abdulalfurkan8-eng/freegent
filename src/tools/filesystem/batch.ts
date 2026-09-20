import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.freegent']);
const MAX_TREE_ENTRIES = 600;
const PER_FILE_CAP = 24_000;   // chars per file in read_files
const TOTAL_CAP = 120_000;     // chars per read_files call

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Recursive project tree with file sizes, in ONE call. */
export async function treeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const base = resolve(ctx.cwd, String(call.path ?? '.'));
  const lines: string[] = [];
  try {
    for await (const file of walk(base)) {
      const info = await stat(file).catch(() => null);
      lines.push(`${relative(ctx.cwd, file)} (${info?.size ?? 0} B)`);
      if (lines.length >= MAX_TREE_ENTRIES) {
        lines.push(`...[truncated at ${MAX_TREE_ENTRIES} entries]`);
        break;
      }
    }
  } catch (err) {
    return fail(`tree: ${(err as Error).message}`);
  }
  if (lines.length === 0) return ok('(empty)');
  return ok(`${lines.length} files:\n${lines.join('\n')}`);
}

/** Read MANY files in one call: {"paths": ["a.ts", "b.ts", ...]} */
export async function readFilesTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const paths = call.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return fail('read_files: "paths" must be a non-empty array of file paths');
  }
  const parts: string[] = [];
  let total = 0;
  for (const p of paths.map(String)) {
    if (total >= TOTAL_CAP) {
      parts.push(`===== ${p} =====\n[skipped: batch size limit reached — request in a new call]`);
      continue;
    }
    try {
      let text = await readFile(resolve(ctx.cwd, p), 'utf8');
      if (text.length > PER_FILE_CAP) {
        text = `${text.slice(0, PER_FILE_CAP)}\n...[truncated ${text.length - PER_FILE_CAP} chars]`;
      }
      total += text.length;
      parts.push(`===== ${p} =====\n${text}`);
    } catch (err) {
      parts.push(`===== ${p} =====\n[error: ${(err as Error).message}]`);
    }
  }
  return ok(parts.join('\n\n'));
}