import { readFile, writeFile } from 'node:fs/promises';
import { ensureRoot, MEMORY_DIR } from '../utils/paths.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type MemoryKind = 'working'|'episodic'|'semantic'|'procedural'|'project'|'computer';
export interface AdvancedMemory {
  id: string; kind: MemoryKind; text: string; timestamp: string;
  importance: number; confidence: number; project?: string; tags?: string[]; accessCount: number;
}

const shard = createHash('sha256').update(projectKey()).digest('hex').slice(0,16);
function projectKey(): string { return process.cwd(); }
const file = join(MEMORY_DIR, `advanced-${shard}.json`);

async function load(): Promise<AdvancedMemory[]> {
  try { return JSON.parse(await readFile(file, 'utf8')) as AdvancedMemory[]; } catch { return []; }
}
async function save(items: AdvancedMemory[]): Promise<void> { await ensureRoot(); await writeFile(file, JSON.stringify(items.slice(-5000), null, 2), 'utf8'); }

const tokenize = (s: string): string[] => [...new Set((s.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []))];

export async function rememberAdvanced(input: Omit<AdvancedMemory,'id'|'accessCount'>): Promise<void> {
  const items = await load();
  items.push({ ...input, id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`, accessCount: 0 });
  await save(items);
}

export async function retrieveAdvanced(query: string, project?: string, limit = 12): Promise<AdvancedMemory[]> {
  const items = await load(); const q = tokenize(query); const now = Date.now();
  const scored = items.map((m) => {
    const text = tokenize(`${m.text} ${(m.tags ?? []).join(' ')} ${m.project ?? ''}`);
    const overlap = q.filter((t) => text.includes(t)).length / Math.max(1, q.length);
    const ageDays = Math.max(0, (now - Date.parse(m.timestamp)) / 86400000);
    const recency = Math.exp(-ageDays / 30);
    const projectBoost = project && m.project === project ? 0.25 : 0;
    const score = overlap * 0.55 + recency * 0.12 + Math.min(1, m.importance) * 0.15 + Math.min(1, m.confidence) * 0.08 + Math.min(1, m.accessCount / 20) * 0.05 + projectBoost;
    return { m, score };
  }).filter((x) => x.score > 0.12).sort((a,b) => b.score-a.score).slice(0, limit);
  if (scored.length) {
    const ids = new Set(scored.map(x => x.m.id));
    for (const m of items) if (ids.has(m.id)) m.accessCount++;
    await save(items);
  }
  return scored.map(x => x.m);
}

export function formatAdvancedMemory(items: AdvancedMemory[]): string {
  return items.map((m) => `- [${m.kind}] ${m.text}`).join('\n');
}
