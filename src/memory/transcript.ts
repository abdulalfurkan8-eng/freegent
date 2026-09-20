import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT_DIR } from '../utils/paths.js';

/** One line of a chat as the app renders it. */
export interface Msg { role: 'user' | 'agent' | 'error'; text: string; at: string }

const DIR = join(ROOT_DIR, 'transcripts');
const MAX_MSGS = 400;

const fileFor = (id: string): string =>
  join(DIR, id.replace(/[^A-Za-z0-9_-]/g, '') + '.json');

/** Everything said in this chat, oldest first. */
export async function loadTranscript(id: string): Promise<Msg[]> {
  try {
    return JSON.parse(await readFile(fileFor(id), 'utf8')) as Msg[];
  } catch {
    return [];
  }
}

/** Append one message; never throws (history must not break a task). */
export async function appendMsg(
  id: string, role: Msg['role'], text: string,
): Promise<void> {
  if (!id || !text) return;
  try {
    const all = await loadTranscript(id);
    all.push({ role, text, at: new Date().toISOString() });
    await mkdir(DIR, { recursive: true });
    await writeFile(fileFor(id), JSON.stringify(all.slice(-MAX_MSGS)), 'utf8');
  } catch { /* history is best-effort */ }
}