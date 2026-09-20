import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';
import { captureScreen, captureAnnotatedScreen } from '../vision/screen.js';
import { uiTree, foregroundWindow } from '../windows/computer.js';

export async function screenObserveTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (process.platform !== 'win32') return fail('screen_observe: Windows only.');
  const wantGrid = String(call.grid ?? '') === 'true';
  try {
    const obs = wantGrid ? await captureAnnotatedScreen(Number(call.gridSpacing) || 100) : await captureScreen();
    ctx.attachImage?.(obs.path);
    const tree = await uiTree(3).catch(() => []);
    const active = await foregroundWindow().catch(() => null);
    ctx.state?.setScreen(obs.width, obs.height, obs.changed, obs.hash, obs.path);
    ctx.state?.setApplication(active?.process, active?.title);
    ctx.state?.setPerception({
      ocr: obs.ocr,
      detectedElements: tree
        .filter((e) => e.width > 0 && e.height > 0 && e.enabled && !e.offscreen)
        .map((e) => ({ type: e.type, name: e.name, bbox: [e.x, e.y, e.width, e.height] as [number,number,number,number], center: [e.x + e.width / 2, e.y + e.height / 2] as [number,number], confidence: e.name?.trim() ? 0.9 : 0.65, source: 'uia', timestamp: Date.now(), screenHash: obs.hash }))
        .slice(0, 400),
    });
    const note = wantGrid
      ? 'Annotated screenshot attached with a pixel-coordinate grid burned in (labels are absolute screen coordinates, matching what "computer" click actions expect). Read the nearest gridlines to estimate a target\'s (x, y) rather than guessing from the raw image.'
      : 'Screenshot attached; use active window + UI Automation first, then OCR/visual grounding. Reuse cached OCR when unchanged. For a precise click on a small or unfamiliar target, call screen_observe again with {"grid":"true"} to get coordinate gridlines burned into the image.';
    return ok(JSON.stringify({ activeWindow: active, changed: obs.changed, hash: obs.hash, changedRegion: obs.changedRegion, ocr: obs.ocr, uiElements: tree.slice(0, 250), note }, null, 2));
  } catch (e) { return fail(`screen_observe failed: ${(e as Error).message}`); }
}
