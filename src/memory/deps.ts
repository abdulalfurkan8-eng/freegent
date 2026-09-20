import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DepEntry { name: string; version: string; dir: string }

const MAX_PKGS = 300;
const MAX_DTS_PER_PKG = 25;

/** Declared dependencies from package.json (deps + devDeps). */
export async function declaredDeps(cwd: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as
      Record<string, Record<string, string>>;
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/** Direct dependencies resolved to their installed folder + version. */
export async function buildDepIndex(cwd: string): Promise<DepEntry[]> {
  const names = Object.keys(await declaredDeps(cwd)).slice(0, MAX_PKGS);
  return Promise.all(names.map(async (name) => {
    const dir = join(cwd, 'node_modules', ...name.split('/'));
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version?: string };
      return { name, version: String(pkg.version ?? '?'), dir };
    } catch {
      return { name, version: '(not installed)', dir };
    }
  }));
}

/** Every installed package, including transitive ones (types often live there). */
async function installedPkgs(cwd: string): Promise<DepEntry[]> {
  const root = join(cwd, 'node_modules');
  const out: DepEntry[] = [];
  let top: string[] = [];
  try { top = await readdir(root); } catch { return out; }
  for (const entry of top) {
    if (entry.startsWith('.') || out.length >= MAX_PKGS) continue;
    if (entry.startsWith('@')) {
      const scoped = await readdir(join(root, entry)).catch(() => [] as string[]);
      for (const s of scoped) {
        if (out.length >= MAX_PKGS) break;
        out.push({ name: `${entry}/${s}`, version: '', dir: join(root, entry, s) });
      }
    } else {
      out.push({ name: entry, version: '', dir: join(root, entry) });
    }
  }
  return out;
}

/** Collect .d.ts files inside a package (bounded walk, skips nested node_modules). */
async function typeFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (found.length >= MAX_DTS_PER_PKG) break;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) found.push(...await typeFiles(full, depth + 1));
    else if (e.name.endsWith('.d.ts')) found.push(full);
  }
  return found.slice(0, MAX_DTS_PER_PKG);
}

/** Grep a symbol across every installed package's type definitions. */
export async function searchDeps(cwd: string, query: string, limit = 40): Promise<string[]> {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  const comments: string[] = [];
  for (const pkg of await installedPkgs(cwd)) {
    if (hits.length >= limit) break;
    for (const file of await typeFiles(pkg.dir)) {
      if (hits.length >= limit) break;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text || text.length > 4_000_000) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length + comments.length < limit * 2; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        const body = lines[i].trim();
        const line = `${file.slice(cwd.length + 1)}:${i + 1}  ${body.slice(0, 110)}`;
        if (/^([*]|[/][/]|[/][*])/.test(body)) comments.push(line);
        else hits.push(line);
      }
    }
  }
  return [...hits, ...comments].slice(0, limit);
}