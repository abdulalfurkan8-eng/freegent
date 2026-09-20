/**
 * Run this FIRST, before touching visionLoop.ts. It only exercises
 * computer.ts, so if something's wrong with mouse/keyboard/screenshot
 * plumbing you find out here instead of debugging it through a model's
 * confusing JSON.
 *
 * Run with:  npx tsx test-computer.ts
 * (must be run on a real Windows machine that owns the desktop session -
 * it will NOT work over SSH/RDP with no active session, or in a container.)
 */
import { writeFile } from 'node:fs/promises';
import {
  captureScreenshot, moveMouse, click, keyboard, launchApplication, focusWindow,
} from './src/windows/computer.js';

async function main() {
  console.log('1) Taking a screenshot...');
  const shot = await captureScreenshot();
  await writeFile('test-screenshot.png', Buffer.from(shot.base64, 'base64'));
  console.log(`   Saved test-screenshot.png (${shot.width}x${shot.height}). Open it and confirm it's actually your screen.`);

  console.log('2) Moving mouse to (200, 200) in 2 seconds - watch your cursor...');
  await new Promise((r) => setTimeout(r, 2000));
  await moveMouse(200, 200);
  console.log('   Did the cursor jump to roughly the top-left area of your screen? If not, coordinate scaling is off (check display scaling %).');

  console.log('3) Launching Notepad...');
  await launchApplication('notepad.exe');
  await new Promise((r) => setTimeout(r, 1000));

  console.log('4) Focusing Notepad window...');
  const focused = await focusWindow('Notepad');
  console.log(`   focusWindow returned: ${focused}`);

  console.log('5) Clicking inside the Notepad text area at (400, 300)...');
  await click('left', 400, 300);

  console.log('6) Typing a test string...');
  await keyboard('type', 'If you can read this in Notepad, keyboard injection works.');

  console.log('7) Sending Ctrl+A then Ctrl+C (select all, copy) as a key-combo test...');
  await keyboard('key', 'ctrl+a');
  await keyboard('key', 'ctrl+c');

  console.log('\nDone. Manually verify: did Notepad open, get focused, get clicked into, and receive the typed text?');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
