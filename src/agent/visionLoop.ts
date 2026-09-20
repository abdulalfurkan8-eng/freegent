import type { LLMProvider } from './provider.js';
import {
  captureScreenshot, moveMouse, click, doubleClick, drag, keyboard, launchApplication, focusWindow,
} from '../windows/computer.js';

/**
 * This is the piece fastComputer.ts was missing: instead of matching a task
 * string against a fixed set of regexes, it shows the model the actual
 * screen and lets it decide what to click, on any app, not just the ones in
 * APP_ALIASES.
 *
 * It is intentionally provider-agnostic - it only needs an LLMProvider whose
 * `send(prompt, signal, images)` can accept a screenshot and return text.
 * Wire in whatever backend you choose there; this loop doesn't care.
 */

export type ComputerAction =
  | { action: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { action: 'double_click'; x: number; y: number }
  | { action: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { action: 'type'; text: string }
  | { action: 'key'; combo: string }
  | { action: 'launch'; app: string }
  | { action: 'focus'; title: string }
  | { action: 'wait'; ms: number }
  | { action: 'done'; summary: string }
  | { action: 'failed'; reason: string };

export interface VisionLoopOptions {
  provider: LLMProvider;
  task: string;
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: number, action: ComputerAction) => void;
}

export interface VisionLoopResult {
  ok: boolean;
  steps: number;
  summary: string;
}

const SYSTEM_INSTRUCTIONS = (task: string, width: number, height: number) => `
You are controlling a real Windows desktop. The screen is ${width}x${height} pixels,
origin (0,0) at the top-left. You will be shown a screenshot of the current
screen state after every action.

TASK: ${task}

Respond with EXACTLY ONE JSON object on a single line, no prose, no markdown
fences, matching one of these shapes:
{"action":"click","x":123,"y":456,"button":"left"}
{"action":"double_click","x":123,"y":456}
{"action":"drag","x1":10,"y1":10,"x2":200,"y2":200}
{"action":"type","text":"hello world"}
{"action":"key","combo":"ctrl+s"}
{"action":"launch","app":"notepad.exe"}
{"action":"focus","title":"Notepad"}
{"action":"wait","ms":500}
{"action":"done","summary":"what you accomplished"}
{"action":"failed","reason":"why you could not continue"}

Look carefully at the screenshot before every action - coordinates must point
at the actual element you intend to interact with. If the task is already
complete, respond with "done" immediately instead of taking another action.
`.trim();

function extractJson(text: string): ComputerAction | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as ComputerAction;
  } catch {
    return null;
  }
}

async function executeAction(a: ComputerAction): Promise<void> {
  switch (a.action) {
    case 'click': return click(a.button ?? 'left', a.x, a.y);
    case 'double_click': return doubleClick(a.x, a.y);
    case 'drag': return drag(a.x1, a.y1, a.x2, a.y2);
    case 'type': return keyboard('type', a.text);
    case 'key': return keyboard('key', a.combo);
    case 'launch': await launchApplication(a.app); return;
    case 'focus': { await focusWindow(a.title); return; }
    case 'wait': return new Promise((r) => setTimeout(r, a.ms));
    default: return;
  }
}

/**
 * Run the perceive -> decide -> act loop until the model reports "done"
 * or "failed", or maxSteps is reached.
 */
export async function runVisionLoop(opts: VisionLoopOptions): Promise<VisionLoopResult> {
  const { provider, task, maxSteps = 25, signal, onStep } = opts;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return { ok: false, steps: step, summary: 'aborted' };

    const shot = await captureScreenshot();
    const prompt = step === 1
      ? SYSTEM_INSTRUCTIONS(task, shot.width, shot.height)
      : 'Here is the current screen after your last action. Continue the task, or respond "done"/"failed" as instructed.';

    const response = await provider.send(prompt, signal, [shot.base64]);
    const action = extractJson(response);

    if (!action) {
      // Model didn't return parseable JSON - treat as a soft failure rather
      // than silently doing nothing, so a caller can retry or bail.
      onStep?.(step, { action: 'failed', reason: 'unparseable model response' });
      return { ok: false, steps: step, summary: `Model response was not valid JSON: ${response.slice(0, 200)}` };
    }

    onStep?.(step, action);

    if (action.action === 'done') return { ok: true, steps: step, summary: action.summary };
    if (action.action === 'failed') return { ok: false, steps: step, summary: action.reason };

    try {
      await executeAction(action);
    } catch (err) {
      return { ok: false, steps: step, summary: `Action execution failed: ${(err as Error).message}` };
    }

    // Give the UI a moment to settle before the next screenshot.
    await new Promise((r) => setTimeout(r, 150));
  }

  return { ok: false, steps: maxSteps, summary: 'Reached max steps without completing the task' };
}

/**
 * Move the mouse pointer without acting - handy for a quick manual sanity
 * check that coordinate math lines up with the real screen before trusting
 * the loop with something destructive.
 */
export async function sanityCheckPointer(x: number, y: number): Promise<void> {
  await moveMouse(x, y);
}
