import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

const FILE = '.freegent/FREEGENT.md';

/**
 * Persist a durable project fact to .freegent/FREEGENT.md so the NEXT session
 * starts smarter (build command, entry point, conventions). Zero API cost -
 * it is fed back in via project context. Append-only, deduped by line.
 */
export async function rememberTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fact = String(call.fact ?? call.note ?? '').trim();
  if (!fact) return fail('remember: "fact" (non-empty string) is required');

  const abs = join(ctx.cwd, FILE);
  let current = '';
  try {
    current = await readFile(abs, 'utf8');
  } catch {
    current = '# Project notes (freegent)\n\nDurable facts learned while working here.\n';
  }

  const line = `- ${fact.replace(/\s+/g, ' ')}`;
  if (current.split('\n').some((l) => l.trim() === line.trim())) {
    return ok(`Already noted: "${fact}"`);
  }

  const next = current.replace(/\s*$/, '') + '\n' + line + '\n';
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, next, 'utf8');
    return ok(`Remembered: "${fact}" (saved to ${FILE} for future sessions).`);
  } catch (err) {
    return fail(`remember: cannot write ${FILE}: ${(err as Error).message}`);
  }
}