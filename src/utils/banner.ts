import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function version(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = version();

export function printBanner(cwd: string): void {
  const rows = [
    `* FreeGent v${VERSION}`,
    'Free AI coding agent - creative, autonomous, and verified',
  ];
  const width = Math.max(...rows.map((r) => r.length)) + 4;
  const horizontal = '\u2500'.repeat(width);

  console.log(chalk.cyan(`\u256D${horizontal}\u256E`));
  rows.forEach((row, i) => {
    const padded = `  ${row}${' '.repeat(width - row.length - 2)}`;
    const styled = i === 0 ? chalk.bold.white(padded) : chalk.dim(padded);
    console.log(chalk.cyan('\u2502') + styled + chalk.cyan('\u2502'));
  });
  console.log(chalk.cyan(`\u2570${horizontal}\u256F`));

  console.log(chalk.dim(`  dir   ${cwd}`));
  console.log(chalk.dim('  keys  Enter send \u2022 Ctrl+C cancel task \u2022 Ctrl+C twice exit \u2022 Alt+V paste image'));
  console.log(chalk.dim('  cmds  /help /resume /fork /rewind /image /clear /exit'));
  console.log('');
}