import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskJournal {
  id: string;
  goal: string;
  startedAt: string;
  status: 'running'|'completed'|'failed'|'interrupted';
  completedSteps: string[];
  failedAttempts: string[];
  changedFiles: string[];
  assumptions: string[];
}

export async function appendTaskJournal(cwd: string, entry: TaskJournal): Promise<void> {
  try {
    const dir = join(cwd, '.freegent');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'tasks.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-critical persistence */ }
}
