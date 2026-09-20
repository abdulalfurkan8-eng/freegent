import { copyFile, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { ROOT_DIR } from '../utils/paths.js';
import { DEFAULTS } from '../config/defaults.js';
import { loadConfig } from '../config/config.js';

const DIR = join(ROOT_DIR, 'checkpoints');
const MANIFEST = join(DIR, 'manifest.json');


interface Checkpoint {
  file: string;
  /** Backup copy path, or null if the file did not exist before the edit. */
  backup: string | null;
  ts: string;
}

async function loadManifest(): Promise<Checkpoint[]> {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8')) as Checkpoint[];
  } catch {
    return [];
  }
}

async function saveManifest(list: Checkpoint[]): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const max = (await loadConfig()).checkpointMaxEntries ?? DEFAULTS.checkpoints.maxEntries;
  await writeFile(MANIFEST, JSON.stringify(list.slice(-max), null, 2), 'utf8');
}

/** Snapshot a file before the agent mutates it (for /rewind). */
export async function checkpointFile(cwd: string, relPath: string): Promise<void> {
  if (!relPath) return;
  const abs = resolve(cwd, relPath);
  await mkdir(DIR, { recursive: true });
  let backup: string | null = null;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return; // only files are checkpointed
    backup = join(DIR, `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${basename(abs)}`);
    await copyFile(abs, backup);
  } catch {
    backup = null; // file is being created for the first time
  }
  const list = await loadManifest();
  list.push({ file: abs, backup, ts: new Date().toISOString() });
  await saveManifest(list);
}

/** Undo the last n file mutations. Returns human-readable result lines. */
export async function rewind(n: number): Promise<string[]> {
  const list = await loadManifest();
  const out: string[] = [];
  for (let i = 0; i < n && list.length > 0; i++) {
    const cp = list.pop();
    if (!cp) break;
    try {
      if (cp.backup) {
        await copyFile(cp.backup, cp.file);
        out.push(`restored ${cp.file}`);
      } else {
        await rm(cp.file, { force: true });
        out.push(`removed ${cp.file} (was newly created)`);
      }
    } catch (err) {
      out.push(`failed ${cp.file}: ${(err as Error).message}`);
    }
  }
  await saveManifest(list);
  if (out.length === 0) out.push('Nothing to rewind.');
  return out;
}