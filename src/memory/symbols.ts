import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.freegent', 'build']);
const MAX_FILES = 400;
const MAX_SYMBOLS = 800;

export interface SymbolEntry {
  name: string;
  kind: string;
  file: string;
}

/** Language patterns - written without backslash escapes on purpose. */
const PATTERNS: Array<{ exts: string[]; res: Array<[RegExp, string]> }> = [
  {
    exts: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
    res: [
      [/^export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z0-9_$]+)/, 'function'],
      [/^(?:export[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z0-9_$]+)/, 'class'],
      [/^(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z0-9_$]+)/, 'function'],
      [/^export[ \t]+const[ \t]+([A-Za-z0-9_$]+)/, 'const'],
      [/^(?:export[ \t]+)?interface[ \t]+([A-Za-z0-9_$]+)/, 'interface'],
      [/^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|async[ \t]+)*([A-Za-z0-9_$]+)[(][^;]*[{][ \t]*$/, 'method'],
    ],
  },
  {
    exts: ['.py'],
    res: [
      [/^class[ \t]+([A-Za-z0-9_]+)/, 'class'],
      [/^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z0-9_]+)/, 'function'],
    ],
  },
  {
    exts: ['.dart', '.java', '.cs', '.kt', '.swift'],
    res: [[/^(?:public[ \t]+|abstract[ \t]+|final[ \t]+)*class[ \t]+([A-Za-z0-9_]+)/, 'class']],
  },
  {
    exts: ['.go'],
    res: [
      [/^func[ \t]+(?:[(][^)]*[)][ \t]*)?([A-Za-z0-9_]+)/, 'function'],
      [/^type[ \t]+([A-Za-z0-9_]+)/, 'type'],
    ],
  },
  {
    exts: ['.rb'],
    res: [
      [/^class[ \t]+([A-Za-z0-9_]+)/, 'class'],
      [/^[ \t]*def[ \t]+([A-Za-z0-9_.?!]+)/, 'method'],
    ],
  },
];

function patternsFor(ext: string): Array<[RegExp, string]> | null {
  for (const group of PATTERNS) {
    if (group.exts.includes(ext)) return group.res;
  }
  return null;
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth - 1);
    else yield full;
  }
}

/** Build a fresh symbol index for the project - fast, local, always current. */
export async function buildSymbolIndex(cwd: string): Promise<SymbolEntry[]> {
  const out: SymbolEntry[] = [];
  let files = 0;
  for await (const file of walk(cwd, 6)) {
    if (files >= MAX_FILES || out.length >= MAX_SYMBOLS) break;
    const res = patternsFor(extname(file).toLowerCase());
    if (!res) continue;
    files++;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(cwd, file);
    for (const rawLine of text.split('\n')) {
      const line = rawLine.endsWith(String.fromCharCode(13)) ? rawLine.slice(0, -1) : rawLine;
      for (const [re, kind] of res) {
        const m = line.match(re);
        if (m) {
          out.push({ name: m[1], kind, file: rel });
          break;
        }
      }
      if (out.length >= MAX_SYMBOLS) break;
    }
  }
  return out;
}