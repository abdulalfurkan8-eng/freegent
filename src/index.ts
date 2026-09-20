#!/usr/bin/env node
/**
 * Android/Termux: Playwright throws "Unsupported platform: android" the
 * moment its registry module loads. Termux is Linux-compatible enough for
 * executablePath mode, so masquerade as linux BEFORE anything that pulls
 * playwright is imported (all app imports below are dynamic for this).
 */
if (process.platform === 'android') {
  process.env.FREEGENT_ANDROID = '1';
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
}

async function main(): Promise<void> {
  const { buildProgram } = await import('./cli/program.js');
  const { logger } = await import('./utils/logger.js');

  process.on('SIGINT', () => {
    logger.warn('Cancelled by user.');
    process.exit(130);
  });

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch(async (err) => {
  const { logger } = await import('./utils/logger.js');
  logger.error(err instanceof Error ? err.message : 'Unknown error', err);
  process.exit(1);
});