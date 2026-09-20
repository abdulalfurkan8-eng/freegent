import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import type { Page } from 'playwright';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';
import { guardTabs, smartClick } from '../browser/hardening.js';
import { pageMap, renderMap, indexSelector } from '../browser/pageMap.js';

type Action =
  | { click: string | number }
  | { type: [string, string] }
  | { press: string }
  | { wait: number };

/** Run the model-provided interaction script against the loaded page. */
async function runActions(page: Page, actions: Action[], notes: string[]): Promise<void> {
  for (const a of actions.slice(0, 20)) {
    try {
      if ('click' in a) {
        const sel = typeof a.click === 'number' || /^\d+$/.test(String(a.click))
          ? indexSelector(Number(a.click))
          : String(a.click);
        await smartClick(page, sel, notes);
        notes.push(`clicked ${a.click}`);
      } else if ('type' in a && Array.isArray(a.type)) {
        const [sel, text] = a.type;
        await page.locator(String(sel)).first().fill(String(text), { timeout: 5000 });
        notes.push(`typed into ${sel}`);
      } else if ('press' in a) {
        await page.keyboard.press(String(a.press));
        notes.push(`pressed ${a.press}`);
      } else if ('wait' in a) {
        await page.waitForTimeout(Math.min(Number(a.wait) || 500, 5000));
      }
      await page.waitForTimeout(400);
    } catch (err) {
      notes.push(`ACTION FAILED ${JSON.stringify(a)}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

export async function testPageTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.newPage) return fail('test_page: browser not available in this context');
  const rel = String(call.path ?? call.url ?? 'index.html');
  let url: string;
  if (/^https?:\/\//i.test(rel)) {
    url = rel;
  } else {
    const abs = resolve(ctx.cwd, rel);
    try { await access(abs); } catch {
      return fail(`test_page: file not found: ${rel}`);
    }
    url = 'file:///' + abs.split('\\').join('/');
  }

  const page = await ctx.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    logs.push(line);
    if (logs.length > 60) logs.shift();
  });

  const actionNotes: string[] = [];
  let mapText = '';
  const unguard = guardTabs(page, actionNotes);
  try {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    } catch (first) {
      if (!String(first).includes('ERR_CONNECTION_REFUSED')) throw first;
      await page.waitForTimeout(4000);
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    }
    await page.waitForTimeout(2500);
    mapText = renderMap(await pageMap(page));

    // Run model-provided interaction script if present.
    let actions: Action[] = [];
    if (Array.isArray(call.actions)) {
      actions = call.actions as Action[];
    } else if (typeof call.actions === 'string') {
      try { actions = JSON.parse(call.actions) as Action[]; } catch { /* ignore */ }
    }
    if (actions.length > 0) {
      await runActions(page, actions, actionNotes);
      await page.waitForTimeout(1000);
    } else {
      // Default: poke common game/menu keys.
      await page.keyboard.press('Enter').catch(() => undefined);
      await page.keyboard.press('Space').catch(() => undefined);
      await page.waitForTimeout(1000);
    }
  } catch (err) {
    errors.push(`load failed: ${(err as Error).message}`);
  } finally {
    unguard();
    await page.close().catch(() => undefined);
  }

  const actionsLine = actionNotes.length > 0
    ? `\nActions: ${actionNotes.join(', ')}` : '';
  const mapLine = mapText
    ? '\n\nClickable elements (click by NUMBER, e.g. {\'click\':3}):\n' + mapText
    : '';
  if (errors.length > 0) {
    const unique = [...new Set(errors)].slice(0, 15);
    return fail(
      `test_page: ${rel} produced ${errors.length} error(s):${actionsLine}\n` +
      `${unique.join('\n')}\nFix these and run test_page again.${mapLine}`,
    );
  }
  const logTail = logs.length > 0
    ? `\nConsole log:\n${logs.slice(-20).join('\n')}` : '';
  return ok(
    `test_page: ${rel} loaded with ZERO errors.${actionsLine}${mapLine}${logTail}`);
}