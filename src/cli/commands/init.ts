import { ensureRoot } from '../../utils/paths.js';
import { loadConfig, saveConfig } from '../../config/config.js';
import { clearMemory } from '../../memory/store.js';
import { logger } from '../../utils/logger.js';

/** Initialize ~/.freegent with config and memory files. */
export async function initCommand(): Promise<void> {
  await ensureRoot();
  const config = await loadConfig();
  await saveConfig(config);
  await clearMemory();
  logger.success('Initialized ~/.freegent');
}