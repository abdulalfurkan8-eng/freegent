import chalk from 'chalk';

export type LogLevel = 'silent' | 'normal' | 'verbose' | 'debug';

class Logger {
  private level: LogLevel = 'normal';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private allows(min: LogLevel): boolean {
    const order: LogLevel[] = ['silent', 'normal', 'verbose', 'debug'];
    return order.indexOf(this.level) >= order.indexOf(min);
  }

  info(msg: string): void {
    if (this.allows('normal')) console.log(chalk.cyan('ℹ'), msg);
  }

  success(msg: string): void {
    if (this.allows('normal')) console.log(chalk.green('✔'), msg);
  }

  warn(msg: string): void {
    if (this.allows('normal')) console.log(chalk.yellow('⚠'), msg);
  }

  error(msg: string, err?: unknown): void {
    console.error(chalk.red('✖'), msg);
    if (err instanceof Error && this.allows('debug')) {
      console.error(chalk.red(err.stack ?? err.message));
    }
  }

  verbose(msg: string): void {
    if (this.allows('verbose')) console.log(chalk.gray('·'), chalk.gray(msg));
  }

  debug(msg: string): void {
    if (this.allows('debug')) {
      console.log(chalk.magenta('◦'), chalk.magenta(`[debug] ${msg}`));
    }
  }

  tool(name: string, detail: string): void {
    if (this.allows('normal')) {
      console.log(chalk.blue('▸'), chalk.bold(name), chalk.dim(detail));
    }
  }

  ai(msg: string): void {
    if (this.allows('normal')) console.log(chalk.white(msg));
  }
}

export const logger = new Logger();