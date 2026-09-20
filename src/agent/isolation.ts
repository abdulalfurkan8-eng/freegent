import { resolve, relative, sep, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';

/** Lexical containment check. Rejects ../ escapes and Windows prefix collisions. */
export function isWithinWorkspaceLexical(cwd: string, target: string): boolean {
  const root = resolve(cwd);
  const candidate = resolve(root, target);
  const r = relative(root, candidate);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !/^[A-Za-z]:/i.test(r));
}

/**
 * Resolve the nearest existing ancestor so new files can still be checked.
 * This catches symlink/junction escapes without requiring the target itself
 * to exist yet.
 */
async function realpathNearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try { return await realpath(current); }
    catch { const parent = dirname(current); if (parent === current) return current; current = parent; }
  }
}

export async function isWithinWorkspace(cwd: string, target: string): Promise<boolean> {
  if (!isWithinWorkspaceLexical(cwd, target)) return false;
  const root = await realpathNearestExisting(cwd);
  const candidate = await realpathNearestExisting(resolve(cwd, target));
  const r = relative(root, candidate);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..');
}
