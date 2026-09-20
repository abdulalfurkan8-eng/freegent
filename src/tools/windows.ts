import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';
import { listWindows, foregroundWindow, focusWindow, launchApplication, closeWindow, windowAction, mouse, keyboard, computerBatch, uiTree, uiAction, findUiElement, verifyUiAction, windowsState, elementAtPoint } from '../windows/computer.js';
import { screenHash } from '../vision/screen.js';

function targetFromCall(call: ToolCall) {
  return {
    name: typeof call.name === 'string' ? call.name : undefined,
    nameContains: typeof call.nameContains === 'string' ? call.nameContains : undefined,
    automationId: typeof call.automationId === 'string' ? call.automationId : undefined,
    className: typeof call.className === 'string' ? call.className : undefined,
    type: typeof call.type === 'string' ? call.type : undefined,
    index: Number.isFinite(Number(call.index)) ? Number(call.index) : 0,
    window: typeof call.window === 'string' ? call.window : undefined,
    handle: typeof call.handle === 'string' ? call.handle : undefined,
  };
}

export async function windowsTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (process.platform !== 'win32') return fail('windows: this tool requires Windows.');
  const action = String(call.action ?? 'list');
  try {
    if (action === 'list') return ok(JSON.stringify(await listWindows(), null, 2));
    if (action === 'foreground') return ok(JSON.stringify(await foregroundWindow(), null, 2));
    if (action === 'state') return ok(JSON.stringify(await windowsState(), null, 0));
    if (action === 'focus') { const title = await focusWindow(String(call.query ?? '')); ctx.state?.setApplication(undefined, title); return ok(`Focused: ${title}`); }
    if (action === 'launch' || action === 'open') {
      const app = String(call.app ?? call.command ?? call.target ?? '').trim();
      if (!app) return fail(`windows ${action} requires app/command/target`);
      return ok(`Launched: ${await launchApplication(app)}`);
    }
    if (action === 'close' || action === 'minimize' || action === 'maximize' || action === 'restore') {
      const query = String(call.query ?? '').trim();
      if (!query) return fail(`windows ${action} requires query`);
      if (action === 'close') return ok(`Closed: ${await closeWindow(query)}`);
      return ok(`${action}: ${await windowAction(action, query)}`);
    }
    if (action === 'ui_tree') return ok(JSON.stringify(await uiTree(Number(call.depth ?? 5), String(call.window ?? '')), null, 2));
    if (action === 'wait') {
      const ms = Math.min(Math.max(Number(call.ms ?? call.duration ?? 500), 0), 30_000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ok(`Waited ${ms}ms for the application to settle.`);
    }
    if (action === 'ui_find') {
      const found = await findUiElement(targetFromCall(call));
      return found ? ok(JSON.stringify(found, null, 2)) : fail('UI element not found with the supplied semantic target.');
    }
    if (action === 'ui_action') {
      const uiAct = String(call.op ?? call.operation ?? call.uiAction ?? 'invoke') as Parameters<typeof uiAction>[0];
      const allowed = new Set(['invoke','focus','setValue','getValue','setRange','toggle','expand','collapse','select','scrollIntoView','click','doubleClick','rightClick','type','paste']);
      if (!allowed.has(uiAct)) return fail(`Unknown ui_action operation: ${uiAct}`);
      return ok(await uiAction(uiAct, targetFromCall(call), String(call.value ?? call.text ?? '')));
    }
    return fail(`windows: unknown action ${action}`);
  } catch (e) { return fail(`windows ${action} failed: ${(e as Error).message}`); }
}

export async function computerTool(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
  if (process.platform !== 'win32') return fail('computer: this tool requires Windows.');
  const action = String(call.action ?? '');
  try {
    if (['click','doubleClick','rightClick','middleClick','move','drag','scroll'].includes(action)) {
      const nums = Array.isArray(call.args) ? call.args.map(Number) : [Number(call.x ?? 0), Number(call.y ?? 0), Number(call.x2 ?? 0), Number(call.y2 ?? 0), Number(call.amount ?? 0), Number(call.duration ?? 250)];
      if (!Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) return fail('computer mouse action requires finite x/y coordinates');

      const isClick = action === 'click' || action === 'doubleClick' || action === 'rightClick';
      // "Click and hope" is the single biggest reliability gap versus a
      // trained computer-use model: without feedback, a miss is silent and
      // compounds over the next several steps. Ground the click against
      // what UIA actually reports under the cursor afterward, and whether
      // the screen changed at all, so the model can self-correct THIS turn.
      const before = isClick ? await screenHash().catch(() => '') : '';
      await mouse(action as Parameters<typeof mouse>[0], nums);
      if (!isClick) return ok(`Mouse ${action} completed at ${nums.slice(0,4).join(', ')}`);

      await new Promise((r) => setTimeout(r, 180));
      const [after, landedOn] = await Promise.all([
        screenHash().catch(() => ''),
        elementAtPoint(nums[0], nums[1]).catch(() => null),
      ]);
      const changed = Boolean(before) && Boolean(after) && before !== after;
      const target = landedOn
        ? `landed on: ${landedOn.type ?? 'unknown'} "${landedOn.name ?? ''}"${landedOn.enabled === false ? ' (DISABLED)' : ''}`
        : 'landed on: nothing UIA recognizes at that point (could be a canvas, custom-rendered control, or the click missed)';
      return ok(
        `Mouse ${action} completed at ${nums.slice(0,4).join(', ')}. ` +
        `Screen ${changed ? 'changed' : 'did NOT visibly change'} after the click. ${target}. ` +
        (changed ? '' : 'If you expected a visible change (a dialog, navigation, a toggle), the click likely missed the intended target — re-check coordinates, consider screen_observe with {"grid":"true"}, or use windows ui_find/ui_action for a named element instead of raw coordinates.'),
      );
    }
    if (action === 'type') { await keyboard('type', String(call.text ?? '')); return ok('Text typed.'); }
    if (action === 'key' || action === 'hotkey') {
      const raw = String(call.value ?? call.key ?? call.keys ?? '');
      const normalized = action === 'hotkey' ? raw.replace(/[,\s]+/g, '+').replace(/\++/g, '+').replace(/^\+|\+$/g, '') : raw;
      if (!normalized) return fail(`computer ${action} requires key/keys/value`);
      await keyboard(action, normalized);
      return ok(`${action} sent: ${normalized}`);
    }
    if (action === 'batch') {
      const raw = call.actions;
      if (!Array.isArray(raw)) return fail('computer batch requires actions array');
      await computerBatch(raw.map((item: any) => ({ ...item, value: item.value ?? item.key ?? item.keys })) as any);
      return ok(`Computer batch completed (${raw.length} actions).`);
    }
    return fail(`computer: unknown action ${action}`);
  } catch (e) { return fail(`computer ${action} failed: ${(e as Error).message}`); }
}
