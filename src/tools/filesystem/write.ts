import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail, diffStat } from '../types.js';

/** Write (create or overwrite) a file with the given full content. */
export async function writeFileTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = String(call.path ?? '');
  if (!path) return fail('write_file: "path" is required');
  if (typeof call.content !== 'string') {
    return fail('write_file: "content" (string) is required');
  }

  const abs = resolve(ctx.cwd, path);
  try {
    const before = await readFile(abs, 'utf8').catch(() => null);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, call.content, 'utf8');
    const lines = call.content.split('\n').length;
    const result = ok(`Wrote ${path} (${call.content.length} bytes, ${lines} lines)`);
    result.display = diffStat(before, call.content);
    return result;
  } catch (err) {
    return fail(`write_file: cannot write ${path}: ${(err as Error).message}`);
  }
}