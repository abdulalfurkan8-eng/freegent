import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

/** Append a chunk to a file (used for writing large files in parts). */
export async function appendFileTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = String(call.path ?? '');
  if (!path) return fail('append_file: "path" is required');
  if (typeof call.content !== 'string' || call.content.length === 0) {
    return fail('append_file: "content" (non-empty string) is required');
  }
  const abs = resolve(ctx.cwd, path);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, call.content, 'utf8');
    const lines = call.content.split('\n').length;
    const result = ok(`Appended ${lines} lines to ${path}. Continue with the next chunk, or move on if the file is complete.`);
    result.display = `+${lines} −0  ▎appended`;
    return result;
  } catch (err) {
    return fail(`append_file: cannot append to ${path}: ${(err as Error).message}`);
  }
}