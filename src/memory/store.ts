import { appendFile, readFile, rm, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MEMORY_DIR, MEMORY_FILE, ensureRoot } from '../utils/paths.js';
import { DEFAULTS } from '../config/defaults.js';

export interface MemoryEntry { role: 'user' | 'assistant' | 'tool'; content: string; timestamp: string; }

const shard = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
const MEMORY_JSONL = join(MEMORY_DIR, `session-${shard}.jsonl`);
const LOCK = `${MEMORY_JSONL}.lock`;

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function clearStaleLock(): Promise<boolean> {
  try {
    const info = JSON.parse(await readFile(join(LOCK, 'owner.json'), 'utf8')) as { pid?: number; acquiredAt?: number };
    if (await processExists(Number(info.pid))) return false;
    if (typeof info.acquiredAt === 'number' && Date.now() - info.acquiredAt < DEFAULTS.memory.lockStaleMs) return false;
    await rm(LOCK, { recursive: true, force: true });
    return true;
  } catch {
    try {
      const info = await stat(LOCK);
      if (Date.now() - info.mtimeMs < DEFAULTS.memory.lockStaleMs) return false;
      await rm(LOCK, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureRoot();
  const started = Date.now();
  while (true) {
    try {
      await mkdir(LOCK);
      await writeFile(join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf8');
      break;
    }
    catch {
      await clearStaleLock();
      if (Date.now() - started > DEFAULTS.memory.lockTimeoutMs) throw new Error('Memory store is locked by another process');
      await new Promise(r => setTimeout(r, DEFAULTS.memory.lockRetryMs));
    }
  }
  try { return await fn(); } finally { await rm(LOCK, { recursive: true, force: true }).catch(() => undefined); }
}

async function migrateLegacy(): Promise<void> {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf8');
    const old = JSON.parse(raw) as MemoryEntry[];
    if (!Array.isArray(old) || old.length === 0) return;
    const existing = await readFile(MEMORY_JSONL, 'utf8').catch(() => '');
    if (!existing.trim()) await writeFile(MEMORY_JSONL, old.slice(-DEFAULTS.memory.maxEntries).map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  } catch { /* legacy file is optional */ }
}

export async function loadMemory(): Promise<MemoryEntry[]> {
  await ensureRoot();
  await migrateLegacy();
  try {
    const raw = await readFile(MEMORY_JSONL, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as MemoryEntry).slice(-DEFAULTS.memory.maxEntries);
  } catch { return []; }
}

export async function appendMemory(entry: MemoryEntry): Promise<void> {
  await withLock(async () => {
    await appendFile(MEMORY_JSONL, JSON.stringify(entry) + '\n', 'utf8');
    const info = await stat(MEMORY_JSONL).catch(() => null);
    if (info && info.size > Math.max(256 * 1024, DEFAULTS.memory.maxEntries * 1024)) {
      const raw = await readFile(MEMORY_JSONL, 'utf8').catch(() => '');
      const entries = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as MemoryEntry);
      const keep = entries.slice(-DEFAULTS.memory.maxEntries);
      await writeFile(MEMORY_JSONL, keep.map(x => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
    }
  });
}

export async function clearMemory(): Promise<void> {
  await withLock(async () => { await writeFile(MEMORY_JSONL, '', 'utf8'); });
}
