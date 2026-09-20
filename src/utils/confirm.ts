import readline from 'node:readline';
import chalk from 'chalk';
import { pauseActiveSpinnerForPrompt, resumeActiveSpinnerAfterPrompt } from './spinnerRegistry.js';

/**
 * The app (serve mode) has no terminal keyboard: it plugs in its own asker
 * that shows a Yes/No popup instead of reading stdin. Without this, a
 * confirmation question would wait on stdin forever and the task froze.
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

/** Free-form prompt returning the raw trimmed input. */
export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(chalk.cyan(`${question} `), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export type ChoiceOption = string | { label: string; value?: string; description?: string };
export type ChoiceAnswer = string | number | string[];

export interface ChoiceQuestion {
  question: string;
  options: ChoiceOption[];
  default?: string | number | string[];
  defaultValue?: string | number | string[];
  multiple?: boolean;
  multiSelect?: boolean;
  allowCustom?: boolean;
  allowSkip?: boolean;
}

/** Ask one structured choice question. Compatible with askUser.ts callers. */
export async function askChoice(
  question: string,
  options: ChoiceOption[] = [],
  allowCustom = true,
  defaultValue?: string | number | string[],
): Promise<ChoiceAnswer> {
  // Use the application's confirmation handler only when a structured
  // question must be surfaced in a non-terminal UI. Returning a boolean
  // here is not a useful choice, so fall back to the terminal interaction.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<ChoiceAnswer>((resolve) => {
    const labels = options.map((option) => typeof option === 'string' ? option : option.label);
    const rendered = labels.map((label, i) => `${i + 1}. ${label}`).join('\n');
    const defaultText = Array.isArray(defaultValue)
      ? defaultValue.join(', ')
      : defaultValue == null ? '' : String(defaultValue);
    rl.question(
      `${chalk.cyan(`? ${question}`)}\n${rendered}${rendered ? '\n' : ''}${chalk.dim(defaultText ? `Choice [${defaultText}]: ` : 'Choice: ')}`,
      (answer) => {
        rl.close();
        const raw = answer.trim();
        if (!raw && defaultValue !== undefined) {
          resolve(defaultValue);
          return;
        }
        const numeric = Number.parseInt(raw, 10);
        if (Number.isFinite(numeric) && numeric >= 1 && numeric <= options.length) {
          const selected = options[numeric - 1];
          resolve(typeof selected === 'string' ? selected : (selected.value ?? selected.label));
          return;
        }
        if (raw.includes(',') && options.length > 0) {
          const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
          if (parts.every((part) => /^\d+$/.test(part))) {
            resolve(parts.map((part) => {
              const selected = options[Number.parseInt(part, 10) - 1];
              return selected == null ? part : typeof selected === 'string' ? selected : (selected.value ?? selected.label);
            }));
            return;
          }
        }
        if (!allowCustom && options.length > 0) {
          const selected = options[0];
          resolve(typeof selected === 'string' ? selected : (selected.value ?? selected.label));
          return;
        }
        resolve(raw);
      },
    );
  });
}


