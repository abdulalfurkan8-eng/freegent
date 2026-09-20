import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { execa } from 'execa';
import { buildSymbolIndex } from './symbols.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.freegent']);

async function gitInfo(cwd: string): Promise<string | null> {
  const branch = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd, reject: false,
  });
  if (branch.exitCode !== 0) return null;
  const status = await execa('git', ['status', '--short'], { cwd, reject: false });
  const changed = status.stdout.trim().split('\n').filter(Boolean).length;
  const log = await execa('git', ['log', '--oneline', '-3'], { cwd, reject: false });
  return [
    `Git: branch=${branch.stdout.trim()}, ${changed} uncommitted change(s)`,
    log.stdout ? `Recent commits:\n${log.stdout}` : '',
  ].filter(Boolean).join('\n');
}

/** Detect main languages from file extensions (top-level + one level deep). */
async function detectLanguages(cwd: string): Promise<string> {
  const counts = new Map<string, number>();
  const scan = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (depth > 0) await scan(join(dir, e.name), depth - 1);
      } else {
        const ext = extname(e.name).toLowerCase();
        if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  };
  await scan(cwd, 2);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, n]) => `${ext}(${n})`);
  return top.length > 0 ? `File types: ${top.join(', ')}` : '';
}

/** Build a project context block, like Claude Code's environment info. */
export async function buildProjectContext(cwd: string): Promise<string> {
  const lines: string[] = [`Project directory: ${cwd}`];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const names = entries
      .filter((e) => !IGNORED.has(e.name))
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    lines.push(`Top-level entries: ${names.join(', ') || '(empty)'}`);
  } catch {
    lines.push('Top-level entries: (unreadable)');
  }

  const langs = await detectLanguages(cwd).catch(() => '');
  if (langs) lines.push(langs);

  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    lines.push(
      `package.json: name=${pkg.name ?? basename(cwd)}, ` +
        `scripts=[${Object.keys(pkg.scripts ?? {}).join(', ')}], ` +
        `deps=[${deps.slice(0, 15).join(', ')}${deps.length > 15 ? ', ...' : ''}]`,
    );
  } catch { /* not a Node project */ }

  try {
    const req = await readFile(join(cwd, 'requirements.txt'), 'utf8');
    const pkgs = req.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    lines.push(`requirements.txt: [${pkgs.slice(0, 15).join(', ')}]`);
  } catch { /* not a Python project */ }

  // Symbol index: small projects get it inline; big ones get a pointer.
  const symbols = await buildSymbolIndex(cwd).catch(() => []);
  if (symbols.length > 0 && symbols.length <= 80) {
    const listing = symbols.map((s) => `${s.name} (${s.kind}) -> ${s.file}`).join('; ');
    lines.push(`Symbol index: ${listing}`);
  } else if (symbols.length > 80) {
    lines.push(`Symbol index: ${symbols.length} symbols available - use the symbols tool to locate any class/function instantly.`);
  }
  const git = await gitInfo(cwd).catch(() => null);
  if (git) lines.push(git);

  // Facts remembered by past sessions (the "remember" tool writes these).
  try {
    const learned = await readFile(join(cwd, '.freegent', 'FREEGENT.md'), 'utf8');
    lines.push(`Learned project facts (from previous sessions):
${learned.slice(0, 2000)}`);
  } catch { /* nothing remembered yet */ }

  // Project instruction file - the FREEGENT.md equivalent of CLAUDE.md.
  for (const name of ['FREEGENT.md', 'CLAUDE.md', 'AGENTS.md']) {
    try {
      const md = await readFile(join(cwd, name), 'utf8');
      lines.push(`${name} project instructions (FOLLOW THESE):\n${md.slice(0, 3000)}`);
      break;
    } catch { /* try next */ }
  }
  return lines.join('\n');
}