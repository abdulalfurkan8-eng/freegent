import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Root directory for all freegent state. */
export const ROOT_DIR = join(homedir(), '.freegent');

/** Persistent Playwright browser profile (stores the DeepSeek session). */
export const PROFILE_DIR = join(ROOT_DIR, 'profile');

/** Global configuration file. */
export const CONFIG_FILE = join(ROOT_DIR, 'config.json');

/** Conversation / memory transcript file. */
export const MEMORY_DIR = join(ROOT_DIR, 'memory');
/** Legacy path retained for migration compatibility. New memory is JSONL in MEMORY_DIR. */
export const MEMORY_FILE = join(ROOT_DIR, 'memory.json');
export const SESSIONS_FILE = join(ROOT_DIR, 'sessions.json');
/** Persistent local App Library profiles and learned app workflows. */
export const APP_LIBRARY_DIR = join(ROOT_DIR, 'app-library');
export const APP_LIBRARY_FILE = join(APP_LIBRARY_DIR, 'profiles.json');

/** Ensure a directory exists (recursive, idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Ensure the whole ~/.freegent tree exists. */
export async function ensureRoot(): Promise<void> {
  await ensureDir(ROOT_DIR);
  await ensureDir(PROFILE_DIR);
  await ensureDir(MEMORY_DIR);
}