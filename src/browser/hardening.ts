import type { Page, BrowserContext } from 'playwright';

/**
 * Hardening for pages that fight automation: popunder tabs, full-screen
 * overlays, and buttons that only enable after a countdown. Without these,
 * a "click" can silently land on a tab nobody is looking at, or on an ad
 * sitting on top of the target - and the model never learns it missed.
 */

/** Close tabs that open while we drive `page`; note them so the model knows. */
export function guardTabs(page: Page, notes: string[]): () => void {
  // page.context() only exists on real Playwright pages.
  // On the Android WebView driver and some agent-internal pages it is absent —
  // degrade silently rather than crashing the whole test_page call.
  let ctx: BrowserContext | null = null;
  try { ctx = (page as Page).context(); } catch { /* not a real Playwright context */ }
  if (!ctx) return () => undefined;
  const onPage = (p: Page): void => {
    if (p === page) return;
    notes.push('blocked a popup tab');
    p.close().catch(() => undefined);
  };
  ctx.on('page', onPage);
  const captured = ctx;
  return () => captured.off('page', onPage);
}

/**
 * Hide whatever element is physically covering the target. Uses
 * elementFromPoint on the target's centre, so it only ever touches the
 * thing actually in the way - it does not blanket-strip the page.
 */
export async function clearBlockers(
  page: Page,
  sel: string,
  tries = 3,
): Promise<string[]> {
  const cleared: string[] = [];
  for (let i = 0; i < tries; i++) {
    const hit = await page.evaluate((s: string) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const top = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      if (!top || top === el || el.contains(top) || top.contains(el)) return null;
      const tag = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '');
      (top as HTMLElement).style.setProperty('display', 'none', 'important');
      return tag;
    }, sel);
    if (!hit) break;
    cleared.push(hit);
  }
  return cleared;
}

/** Click that waits for enabled, then clears blockers and retries once. */
export async function smartClick(
  page: Page,
  sel: string,
  notes: string[],
): Promise<void> {
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 15_000 });
  if (!(await loc.isEnabled())) {
    notes.push(`${sel} is disabled - waiting for it to enable`);
    for (let i = 0; i < 60 && !(await loc.isEnabled()); i++) {
      await page.waitForTimeout(1000);
    }
    if (!(await loc.isEnabled())) {
      throw new Error(`${sel} never became enabled (stuck countdown?)`);
    }
  }
  try {
    await loc.click({ timeout: 5000 });
  } catch {
    const cleared = await clearBlockers(page, sel);
    if (cleared.length > 0) notes.push(`removed overlay ${cleared.join(', ')}`);
    await loc.click({ timeout: 5000 });
  }
}