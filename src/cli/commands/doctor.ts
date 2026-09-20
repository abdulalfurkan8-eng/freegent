import { access } from 'node:fs/promises';
import { execPath, version } from 'node:process';
import { CONFIG_FILE, PROFILE_DIR } from '../../utils/paths.js';
import { loadConfig } from '../../config/config.js';
import { isTermux, findTermuxChromium, TERMUX_SETUP_HELP } from '../../utils/platform.js';
import { logger } from '../../utils/logger.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Print environment and setup diagnostics. */
export async function doctorCommand(): Promise<void> {
  const config = await loadConfig();
  logger.info(`Node: ${version} (${execPath})`);
  logger.info(`Platform: ${process.platform}${isTermux() ? ' (Android Termux)' : ''}`);
  logger.info(`Config file: ${await exists(CONFIG_FILE) ? 'present' : 'missing'}`);
  logger.info(`Profile dir: ${await exists(PROFILE_DIR) ? 'present' : 'missing'}`);
  logger.info(`Provider: ${config.provider}`);
  logger.info(`DeepSeek URL: ${config.chatUrl}`);
  logger.info(`Gemini URL: ${config.geminiUrl}`);
  logger.info(`Gemini mode: browser/web (no API key)`);
  logger.info(`Headless: ${String(config.headless)}`);
  logger.info(`Max iterations: ${String(config.maxIterations)}`);

  if (isTermux()) {
    const chromium = await findTermuxChromium();
    if (chromium) {
      logger.success(`Termux chromium: ${chromium}`);
    } else {
      logger.error('Termux chromium: NOT FOUND');
      logger.info(TERMUX_SETUP_HELP);
    }
    logger.info('Termux notes: browser always runs headless; images/screenshot tools are disabled.');
  }
}