import { rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';
import { confirm } from '../../utils/confirm.js';
import { logger } from '../../utils/logger.js';

/** Delete a file or directory after explicit user confirmation. */
export async function deleteFileTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = String(call.path ?? '');
  if (!path) return fail('delete_file: "path" is required');

  const abs = resolve(ctx.cwd, path);
  try {
    const info = await stat(abs);
    const kind = info.isDirectory() ? 'directory' : 'file';
    logger.warn(`AI wants to delete ${kind}: ${path}`);
    const approved = await confirm(`Delete ${kind} "${path}"?`);
    if (!approved) {
      return ok(`User declined to delete ${path}. Skipped.`);
    }
    await rm(abs, { recursive: true, force: true });
    return ok(`Deleted ${kind} ${path}`);
  } catch (err) {
    return fail(`delete_file: cannot delete ${path}: ${(err as Error).message}`);
  }
}