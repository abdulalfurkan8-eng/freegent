/**
 * A running `ora` spinner redraws its own line on an interval (independent
 * of anything else writing to stdout). If a confirm()/ask() prompt tries to
 * print a question while a spinner is still active, the spinner's next tick
 * overwrites it almost immediately - the question flashes and is gone, so
 * the Yes/No options never actually appear on screen.
 *
 * The spinner owner (session.ts) registers its instance here; any prompt
 * utility can then pause it for the duration of the question and resume it
 * afterward, regardless of which module owns the spinner.
 */
export interface PausableSpinner {
  isSpinning: boolean;
  stop(): unknown;
  start(): unknown;
}

let active: PausableSpinner | null = null;

/** Called by whichever code owns the current task spinner. Pass null to unregister. */
export function registerActiveSpinner(spinner: PausableSpinner | null): void {
  active = spinner;
}

/** Stop the active spinner (if any) so a prompt can print cleanly. Returns whether it was spinning. */
export function pauseActiveSpinnerForPrompt(): boolean {
  if (active && active.isSpinning) {
    active.stop();
    return true;
  }
  return false;
}

/** Resume the active spinner if pauseActiveSpinnerForPrompt() reported it was spinning. */
export function resumeActiveSpinnerAfterPrompt(wasSpinning: boolean): void {
  if (wasSpinning && active) active.start();
}