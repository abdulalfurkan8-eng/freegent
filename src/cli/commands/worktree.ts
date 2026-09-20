import { execa } from 'execa';
import { basename, dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';

/**
 * Create an isolated git worktree so a second freegent session can work on
 * the same repo in parallel without file conflicts.
 */
export async function worktreeCommand(name: string): Promise<void> {
  const root = await execa('git', ['rev-parse', '--show-toplevel'], { reject: false });
  if (root.exitCode !== 0) {
    logger.error('Not inside a git repository.');
    return;
  }
  const repoRoot = root.stdout.trim();
  const dest = join(dirname(repoRoot), `${basename(repoRoot)}-${name}`);
  const r = await execa('git', ['worktree', 'add', dest, '-b', name], {
    cwd: repoRoot,
    reject: false,
  });
  if (r.exitCode !== 0) {
    logger.error(r.stderr || r.stdout || 'git worktree failed');
    return;
  }
  logger.success(`Worktree created: ${dest} (branch "${name}")`);
  logger.info('Open a new terminal there and run "freegent" for a parallel session.');
  logger.info(`When done: git worktree remove "${dest}"`);
}