import { loadConfig, updateConfig } from '../../config/config.js';
import { logger } from '../../utils/logger.js';

/** Show or update runtime configuration. */
export async function configCommand(
  key?: string,
  value?: string,
): Promise<void> {
  if (!key) {
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (!value) {
    throw new Error('Config value is required. Example: freegent config provider gemini');
  }
  if (key === 'provider' && value !== 'deepseek' && value !== 'gemini') {
    throw new Error('provider must be deepseek or gemini');
  }
  const parsed: unknown =
    value === 'true' ? true : value === 'false' ? false : Number.isFinite(Number(value)) ? Number(value) : value;

  await updateConfig({ [key]: parsed } as Record<string, unknown>);
  logger.success(`Updated config: ${key}=${String(parsed)}`);
}