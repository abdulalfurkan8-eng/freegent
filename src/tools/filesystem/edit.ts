import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail, diffStat } from '../types.js';

/** Escape a string for use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whitespace-tolerant fallback: match `find` allowing any indentation and
 * line-ending differences. Returns the ACTUAL text matched, or null.
 */
function fuzzyLocate(haystack: string, find: string): string | null {
  const pattern = find
    .split('\n')
    .map((line) => reEscape(line.trim()))
    .join('\\r?\\n\\s*');
  try {
    const m = haystack.match(new RegExp(pattern.replace(/^/, '[ \\t]*')));
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** Replace an exact substring in a file (first occurrence, or all). */
export async function editFileTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = String(call.path ?? '');
  if (!path) return fail('edit_file: "path" is required');
  if (typeof call.find !== 'string' || call.find.length === 0) {
    return fail('edit_file: "find" (non-empty string) is required');
  }
  if (typeof call.replace !== 'string') {
    return fail('edit_file: "replace" (string) is required');
  }

  const abs = resolve(ctx.cwd, path);
  try {
    const original = await readFile(abs, 'utf8');
    let find = call.find;
    let note = '';

    if (!original.includes(find)) {
      // Exact match failed - try whitespace-tolerant matching before giving up.
      const fuzzy = fuzzyLocate(original, find);
      if (!fuzzy) {
        const firstLine = find.split('\n')[0].trim().slice(0, 60);
        return fail(
          `edit_file: "find" text not found in ${path} (searched exact and ` +
            `whitespace-tolerant). First line sought: "${firstLine}". ` +
            `read_file the current content and retry with exact text.`,
        );
      }
      find = fuzzy;
      note = ' (matched with whitespace tolerance)';
    }

    const occurrences = original.split(find).length - 1;
    const replaceAll = call.all === true;
    if (occurrences > 1 && !replaceAll) {
      return fail(
        `edit_file: "find" text appears ${occurrences} times in ${path}. ` +
          `Add more surrounding context to make it unique, or set "all": true ` +
          `to replace every occurrence.`,
      );
    }
    const updated = replaceAll
      ? original.split(find).join(call.replace)
      : original.replace(find, call.replace);
    await writeFile(abs, updated, 'utf8');
    const n = replaceAll ? occurrences : 1;
    const result = ok(`Edited ${path}: ${n} replacement${n === 1 ? '' : 's'}${note}`);
    result.display = diffStat(original, updated);
    return result;
  } catch (err) {
    return fail(`edit_file: cannot edit ${path}: ${(err as Error).message}`);
  }
}