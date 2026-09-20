import { rm } from 'node:fs/promises';
import { PROFILE_DIR } from '../../utils/paths.js';
import { confirm } from '../../utils/confirm.js';
import { logger } from '../../utils/logger.js';

/** Delete the persistent browser profile and log the user out. */
export async function logoutCommand(): Promise<void> {
  const approved = await confirm('Delete the saved DeepSeek browser session?');
  if (!approved) {
    logger.info('Logout cancelled.');
    return;
  }
  await rm(PROFILE_DIR, { recursive: true, force: true });
  logger.success('Saved DeepSeek browser session removed.');
}