import type { Page, Locator } from 'playwright';
import { SELECTORS, selectorList, discoverSelector } from './selectors.js';
import { DEFAULTS } from '../config/defaults.js';

const LOGIN_TIMEOUT_MS = DEFAULTS.browser.loginTimeoutMs;

/** What the assistant column looked like before we sent a prompt. */
export interface AssistantSnapshot {
  count: number;
  lastText: string;
}

/**
 * Find the chat composer by polling each candidate selector for a VISIBLE
 * match. Ignores hidden elements such as the reCAPTCHA textarea.
 */
export async function findComposer(
  page: Page,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of SELECTORS.composer) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = candidates.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    const discovered = await discoverSelector(page, 'composer');
    if (discovered) { const el = page.locator(discovered).first(); if (await el.isVisible().catch(() => false)) return el; }
    await page.waitForTimeout(1000);
  }
  throw new Error(
    'Could not find the DeepSeek chat input. Are you logged in? ' +
      'Run "freegent login" and complete the login in the browser window.',
  );
}

/**
 * Wait until the chat box is visible. Fails FAST (not 10 minutes) when the
 * page is clearly a sign-in screen or a CloudFront 403 block - both mean
 * waiting longer cannot help.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const composer = await findComposer(page, 8_000).catch(() => null);
    if (composer) return;
    const body = await page.locator('body').innerText().catch(() => '');
    // 403 block will never resolve - fail immediately with clear message.
    if (/403 ERROR|could not be satisfied|Request blocked/i.test(body)) {
      throw new Error(
        'DeepSeek blocked this browser session (CloudFront 403). ' +
        'Try again in a minute, or run "freegent config headless false".',
      );
    }
    // Sign-in page is expected before login - keep waiting for the user.
  }
  throw new Error('Timed out waiting for the DeepSeek chat box. ' +
    'If you see a sign-in page, log in and wait for the chat to load.');
}

/**
 * Recover a page that has stopped responding (composer wedged, chat frozen,
 * or a transient network hiccup). A full reload almost never loses the
 * conversation - DeepSeek keeps chat history server-side, keyed by the URL -
 * so this is safe to try before giving up entirely.
 */
export async function recoverStuckPage(page: Page): Promise<boolean> {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    await findComposer(page, 20_000);
    return true;
  } catch {
    return false;
  }
}

/** Read the composer's current content (textarea or contenteditable). */
async function composerText(box: Locator): Promise<string> {
  const asInput = await box.inputValue().catch(() => null);
  if (asInput !== null) return asInput;
  return (await box.innerText().catch(() => '')) ?? '';
}

/**
 * Send a prompt into the active DeepSeek chat and VERIFY it was actually
 * submitted (composer cleared). Right after a reply finishes, the composer
 * sometimes ignores the first Enter, which used to leave the message sitting
 * unsent — the cause of silent "Waiting for DeepSeek..." stalls.
 */
let lastSendAt = 0;
let sendBackoffMs = 0;
async function respectSendRateLimit(): Promise<void> {
  const wait = Math.max(sendBackoffMs, DEFAULTS.browser.deepSeekBackoffBaseMs - (Date.now() - lastSendAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
function noteSendSuccess(): void { lastSendAt = Date.now(); sendBackoffMs = 0; }
async function noteSendFailure(page: Page, attempt: number): Promise<void> {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/\b429\b|too many requests|403 ERROR|request blocked|cloudfront/i.test(body)) {
    sendBackoffMs = Math.min(DEFAULTS.browser.deepSeekBackoffMaxMs, DEFAULTS.browser.deepSeekBackoffBaseMs * 2 ** Math.min(attempt, 5));
    await page.waitForTimeout(sendBackoffMs);
  }
}

export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  await respectSendRateLimit();
  if (await trySend(page, prompt, 6)) { noteSendSuccess(); return; }
  // Composer wedged (happens after long sessions / big inputs). Reload the
  // page - the conversation survives, the stuck composer state does not.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(3000);
  await noteSendFailure(page, 1);
  if (await trySend(page, prompt, 4)) { noteSendSuccess(); return; }
  throw new Error('Timed out sending message to DeepSeek (composer never cleared, even after page reload)');
}

/**
 * Click the real send button next to the composer. Selector lists are too
 * blind for this (button:has(svg) matches menus and sidebars); instead we
 * walk up from the composer and click the last enabled button in its row -
 * on DeepSeek that is the send arrow. Runs as page JS so it works both in
 * Playwright and in the Android WebView driver.
 */
async function clickComposerSend(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0; };
    const eds = Array.from(
      document.querySelectorAll('textarea, [contenteditable="true"]')).filter(vis);
    const ed = eds[eds.length - 1];
    if (!ed) return false;
    let scope = ed.parentElement;
    for (let depth = 0; scope && depth < 6; depth++) {
      const btns = Array.from(scope.querySelectorAll('button, [role="button"]'))
        .filter(vis).filter((b) => !b.disabled && !b.getAttribute('aria-disabled'));
      if (btns.length) { btns[btns.length - 1].click(); return true; }
      scope = scope.parentElement;
    }
    return false;
  })()`).catch(() => undefined);
}

/** One full attempt cycle: clear, fill, then Enter/send-button with retries. */
async function trySend(page: Page, prompt: string, attempts: number): Promise<boolean> {
  const box = await findComposer(page, 60_000).catch(() => null);
  if (!box) return false;

  // Clear composer thoroughly before typing
  await box.click();
  await page.waitForTimeout(300);
  await box.press('Control+A');
  await page.waitForTimeout(100);
  await box.press('Delete');
  await page.waitForTimeout(300);

  // Type the prompt
  await box.fill(prompt);
  await page.waitForTimeout(500);

  for (let attempt = 0; attempt < attempts; attempt++) {
    await box.press('Enter');
    await page.waitForTimeout(1500);
    if ((await composerText(box)).trim().length === 0) {
      // The composer clearing normally means submission succeeded. Give the
      // UI a short window to expose the generation state before returning.
      await page.waitForTimeout(350);
      return true;
    }

    // Enter was ignored (mobile layouts often only submit via the button) -
    // click the send button sitting next to the composer.
    await clickComposerSend(page);
    await page.waitForTimeout(1500);
    if ((await composerText(box)).trim().length === 0) {
      // The composer clearing normally means submission succeeded. Give the
      // UI a short window to expose the generation state before returning.
      await page.waitForTimeout(350);
      return true;
    }

    // Last resort: the old selector-based guess.
    const sendBtn = page.locator(selectorList(SELECTORS.sendButton)).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      if ((await composerText(box)).trim().length === 0) {
      // The composer clearing normally means submission succeeded. Give the
      // UI a short window to expose the generation state before returning.
      await page.waitForTimeout(350);
      return true;
    }
    }

    // Wait longer on each retry
    await noteSendFailure(page, attempt);
    await page.waitForTimeout(Math.min(10_000, 1000 * (attempt + 1)));
  }
  return false;
}

/** Capture the assistant message count/text BEFORE sending, for comparison. */
async function assistantNodes(page: Page): Promise<{ count: number; lastText: string }> {
  // DeepSeek has changed its message DOM several times. Prefer explicit
  // assistant selectors, then fall back to visible article/message containers.
  const loc = page.locator(selectorList(SELECTORS.assistantMessage));
  const count = await loc.count().catch(() => 0);
  let lastText = '';
  for (let i = count - 1; i >= 0; i--) {
    const node = loc.nth(i);
    if (!(await node.isVisible().catch(() => false))) continue;
    const text = (await node.innerText().catch(() => '')).trim();
    if (!text) continue;
    // Ignore composer text and obvious navigation/status regions.
    if (await node.locator('textarea, input, [contenteditable="true"]').count().catch(() => 0)) continue;
    lastText = text;
    break;
  }
  return { count, lastText };
}

export async function snapshotAssistant(page: Page): Promise<AssistantSnapshot> {
  const { count, lastText } = await assistantNodes(page);
  return { count, lastText };
}

/**
 * Wait for a NEW assistant reply (one that did not exist in `before`), then
 * wait until it stops changing for idleMs. `signal` aborts the wait cleanly.
 */
export async function waitForCompleteResponse(
  page: Page,
  idleMs: number,
  timeoutMs: number,
  before: AssistantSnapshot,
  signal?: AbortSignal,
  onProgress?: (replyChars: number) => void,
): Promise<string> {
  const STALL_MS = 45_000; // no generation + no new reply for this long = stall
  const start = Date.now();
  let last = '';
  let stableSince = Date.now();
  let lastActivity = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('interrupted');
    const observed = await assistantNodes(page);
    const count = observed.count;
    const text = observed.lastText;
    const stopVisible = await page
      .locator(selectorList(SELECTORS.stopButton))
      .first()
      .isVisible()
      .catch(() => false);
    if (stopVisible) lastActivity = Date.now(); // actively generating

    // Only a genuinely NEW reply counts: more messages than before, or the
    // last message's text differs from what was there before we sent.
    const isNew =
      count > before.count || (text.length > 0 && text !== before.lastText);

    if (isNew) {
      if (text !== last) {
        last = text;
        stableSince = Date.now();
        lastActivity = Date.now();
        onProgress?.(text.length); // report growing reply for live token count
      }
      if (!stopVisible && last && Date.now() - stableSince >= idleMs) {
        return last;
      }
    } else if (Date.now() - lastActivity >= STALL_MS) {
      // Nothing generating and no new reply — message likely never sent.
      throw new Error('Timed out waiting for DeepSeek response (stalled)');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for DeepSeek response');
}

/** True when the page is on an existing conversation (has a chat id in URL). */
function onOldConversation(page: Page): boolean {
  return /\/chat\/|\/a\//.test(new URL(page.url()).pathname);
}

/**
 * Open a brand-new chat and VERIFY we actually left the old conversation.
 * Tries the New Chat button, then falls back to a hard navigation to the
 * home URL - guaranteeing a clean, empty conversation.
 */
export async function startNewChat(page: Page, chatUrl: string): Promise<void> {
  const btn = page.locator(selectorList(SELECTORS.newChat)).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1200);
    if (!onOldConversation(page)) return; // button worked
  }
  // Fallback (or button silently failed): hard-navigate to home.
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
}

/** Navigate to a previously saved chat URL to resume that conversation. */
export async function openChatByUrl(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
}

/** Auto-enable DeepThink and Search toggles (used on Termux where user cannot click). */
export async function enableFeatureToggles(page: Page): Promise<void> {
  // Give mobile browser extra time to render the toolbar buttons.
  await page.waitForTimeout(3000);
  for (const selList of [SELECTORS.deepThink, SELECTORS.search]) {
    const btn = page.locator(selectorList(selList)).first();
    if (!await btn.isVisible().catch(() => false)) continue;
    // DeepSeek always starts each chat with these OFF — just click to enable.
    // Avoid isOn detection: it can silently skip clicks due to unrelated class names.
    await btn.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}
/** The current chat's URL (DeepSeek gives each chat a unique path). */
export function currentChatUrl(page: Page): string {
  return page.url();
}