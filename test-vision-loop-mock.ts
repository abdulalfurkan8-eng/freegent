/**
 * Tests visionLoop.ts WITHOUT a real model. A fake LLMProvider just plays
 * back a fixed script of actions, so you can confirm the loop's plumbing -
 * screenshot → prompt → parse JSON → execute → repeat → stop on "done" -
 * actually works before you spend any tokens or debug a real model's output.
 *
 * Run with:  npx tsx test-vision-loop-mock.ts
 */
import type { LLMProvider } from './src/agent/provider.js';
import { runVisionLoop } from './src/agent/visionLoop.js';

/**
 * Plays back one action per call to send(), ignoring the prompt/image
 * entirely. This proves the loop's control flow independent of any model's
 * ability to actually read a screenshot.
 */
class ScriptedFakeProvider implements LLMProvider {
  private i = 0;
  constructor(private script: string[]) {}
  async send(): Promise<string> {
    const next = this.script[this.i];
    this.i += 1;
    if (next === undefined) return JSON.stringify({ action: 'failed', reason: 'script exhausted' });
    console.log(`  [fake model] step ${this.i} responding with: ${next}`);
    return next;
  }
}

async function main() {
  const script = [
    JSON.stringify({ action: 'launch', app: 'notepad.exe' }),
    JSON.stringify({ action: 'wait', ms: 800 }),
    JSON.stringify({ action: 'focus', title: 'Notepad' }),
    JSON.stringify({ action: 'click', x: 400, y: 300 }),
    JSON.stringify({ action: 'type', text: 'scripted test via visionLoop' }),
    JSON.stringify({ action: 'done', summary: 'Opened Notepad and typed the test string' }),
  ];

  const provider = new ScriptedFakeProvider(script);

  const result = await runVisionLoop({
    provider,
    task: 'Open Notepad and type a test string (this task text is ignored by the fake provider)',
    maxSteps: 10,
    onStep: (step, action) => console.log(`  step ${step} executed:`, action),
  });

  console.log('\nResult:', result);
  console.log(result.ok ? 'PASS: loop completed and stopped on "done" as expected.' : 'FAIL: loop did not complete cleanly - see summary above.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

/**
 * Second scenario worth running manually: change the script above to
 * include a malformed entry, e.g. '{"action":"click","x":' (broken JSON),
 * and confirm the loop returns {ok:false, summary:'Model response was not
 * valid JSON...'} instead of throwing or hanging. That's the failure mode
 * a real, imperfect model will actually produce sometimes.
 */
