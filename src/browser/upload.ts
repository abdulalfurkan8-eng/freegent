import { basename } from 'node:path';
import type { Page } from 'playwright';

/**
 * Attach an image file to the DeepSeek composer.
 *
 * DeepSeek's React UI does NOT keep a visible <input type="file"> in the DOM.
 * It creates one lazily when the attach button is clicked, then immediately
 * disposes it. That means:
 *   - Synthetic ClipboardEvent('paste') is ignored (React doesn't wire it).
 *   - Querying for input[type=file] before clicking always finds nothing.
 *
 * The only reliable strategy is:
 *   1. Register page.waitForEvent('filechooser') BEFORE clicking.
 *   2. Click the attach button — this opens the OS picker.
 *   3. Playwright intercepts the picker at the browser level and we set files.
 *
 * We try a broad list of selectors for the attach button. DeepSeek's
 * class names are generated/obfuscated so we match on aria-label and
 * structural position instead of class strings.
 */

// Ordered by specificity — try these in turn until one triggers a filechooser.
const ATTACH_BUTTON_SELECTORS = [
  // Explicit aria labels (most specific, most future-proof)
  '[aria-label="Upload files"]',
  '[aria-label="Attach files"]',
  '[aria-label="Upload"]',
  '[aria-label="Attach"]',
  '[aria-label*="upload" i]',
  '[aria-label*="attach" i]',
  '[aria-label*="image" i]',
  '[aria-label*="photo" i]',
  '[aria-label*="file" i]',
  // title attributes
  '[title*="upload" i]',
  '[title*="attach" i]',
  // data attributes that frameworks sometimes use
  '[data-testid*="upload" i]',
  '[data-testid*="attach" i]',
  // SVG icon buttons near the composer (paperclip-style) —
  // DeepSeek places these as the first few buttons left of the send button.
  'textarea ~ * svg',
  'form svg',
];

export async function attachFile(page: Page, filePath: string): Promise<void> {
  // Bail early with a clear message if not on the chat page.
  if (/sign_in|login/i.test(page.url())) {
    throw new Error(
      'not signed in to DeepSeek — image cannot be attached. ' +
      'Open the app and sign in first.',
    );
  }

  // Check the composer exists at all.
  const hasComposer =
    (await page.locator('textarea, [contenteditable="true"]').count()) > 0;
  if (!hasComposer) {
    throw new Error(
      `no DeepSeek composer found on ${page.url()} — image cannot be attached.`,
    );
  }

  // Read file once up front — used by both strategies below.
  const { readFile } = await import('node:fs/promises');
  const b64 = (await readFile(filePath)).toString('base64');

  // ── Strategy 1: drag-and-drop onto the textarea ──────────────────────────
  const dropped = await page.evaluate(
    async ({ b64: data }: { b64: string }) => {
      const bytes = atob(data);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const file = new File([arr], 'image.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target =
        document.querySelector('textarea') ??
        document.querySelector('[contenteditable="true"]') ??
        document.body;
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true }));
      await new Promise((r) => setTimeout(r, 1000));
      return (
        document.querySelectorAll(
          '[class*="preview"] img, [class*="thumb"] img, [class*="attach"] img, ' +
          '[class*="file"] img, [class*="upload"] img',
        ).length > 0
      );
    },
    { b64 },
  );

  if (dropped) {
    await _waitForUpload(page);
    return;
  }

  // ── Strategy 2: click the attach button, intercept the file chooser ──────
  // page.waitForEvent('filechooser') must be registered BEFORE the click or
  // the event fires before we're listening.
  for (const sel of ATTACH_BUTTON_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) === 0) continue;
    try {
      const [fc] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 3000 }),
        btn.click({ timeout: 2000 }),
      ]);
      await fc.setFiles(filePath);
      await _waitForUpload(page);
      return;
    } catch {
      // This element didn't open a file picker — try the next selector.
    }
  }

  // ── Strategy 3: input[type=file] already in DOM (older DeepSeek builds) ──
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) > 0) {
    await input.setInputFiles(filePath);
    await _waitForUpload(page);
    return;
  }

  throw new Error(
    `Could not attach ${basename(filePath)} — none of the ${ATTACH_BUTTON_SELECTORS.length} ` +
    'attach-button strategies triggered a file picker. ' +
    'Run "node dist/index.js login" to re-authenticate, then retry.',
  );
}

async function _waitForUpload(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const uploading = await page
      .locator('[class*="uploading"], [class*="progress"], [class*="spinner"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!uploading) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200);
}