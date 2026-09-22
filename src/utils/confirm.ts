import readline from 'node:readline';
import chalk from 'chalk';
import { pauseActiveSpinnerForPrompt, resumeActiveSpinnerAfterPrompt } from './spinnerRegistry.js';

/**
 * The app (serve mode) has no terminal keyboard: it plugs in its own asker
 * that shows a Yes/No popup instead of reading stdin. Without this, a
 * confirmation question would wait on stdin forever and the task froze.
 * The interactive REPL also uses this to route confirm() through its own
 * existing readline interface instead of creating a competing one.
 */
type Asker = (question: string) => Promise<boolean>;
let customAsker: Asker | null = null;
export function setConfirmHandler(fn: Asker | null): void { customAsker = fn; }

/**
 * Ask the user a yes/no question on the terminal.
 * Defaults to "no" on empty input for safety.
 */
export function confirm(question: string): Promise<boolean> {
  if (customAsker) return customAsker(question);
  // A spinner still redrawing its own line would overwrite this question
  // before the person ever sees it - pause it for the duration of the ask.
  const wasSpinning = pauseActiveSpinnerForPrompt();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(chalk.yellow(`\n? ${question} `) + chalk.dim('(y/N) '), (answer) => {
      rl.close();
      resumeActiveSpinnerAfterPrompt(wasSpinning);
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}