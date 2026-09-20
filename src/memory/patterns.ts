import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_DIR, ensureRoot } from '../utils/paths.js';

export interface ProjectPattern {
  project: string;
  timestamp: string;
  libs: string[];
  patterns: Array<{ name: string; example: string; count: number }>;
  conventions: string;
}

const PATTERNS_DIR = join(MEMORY_DIR, 'patterns');

/** Find similar saved patterns by lib overlap. */
async function findSimilarPatterns(libs: string[]): Promise<ProjectPattern[]> {
  try {
    await ensureRoot();
    const files = await readdir(PATTERNS_DIR).catch(() => []);
    const results: ProjectPattern[] = [];
    for (const file of files.slice(0, 5)) {
      // Load recent patterns only
      try {
        const content = await readFile(join(PATTERNS_DIR, file), 'utf8');
        const pattern = JSON.parse(content) as ProjectPattern;
        const overlap = libs.filter((l) => pattern.libs.includes(l)).length;
        if (overlap > 0) results.push(pattern);
      } catch {
        /* skip bad files */
      }
    }
    return results.slice(0, 3);
  } catch {
    return [];
  }
}

/** Format loaded patterns into a prompt addendum. */
export function formatPatterns(patterns: ProjectPattern[]): string {
  if (patterns.length === 0) return '';
  const sections: string[] = ['## Learned Patterns from Similar Projects\n'];
  for (const p of patterns) {
    sections.push(`### ${p.project}`);
    if (p.conventions) sections.push(`Conventions: ${p.conventions}`);
    for (const pat of p.patterns.slice(0, 3)) {
      sections.push(`- **${pat.name}**: \`${pat.example}\``);
    }
  }
  return sections.join('\n');
}

/** Load and format patterns based on detected libs. Call at task start. */
export async function loadProjectPatterns(libs: string[]): Promise<string> {
  const similar = await findSimilarPatterns(libs);
  return formatPatterns(similar);
}
