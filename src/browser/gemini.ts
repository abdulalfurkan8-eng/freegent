import type { Page, Locator } from 'playwright';

export const GEMINI_URL = 'https://gemini.google.com/';

const COMPOSER_SELECTORS = [
  'div[contenteditable="true"][role="textbox"]',
  'rich-textarea [contenteditable="true"]',
  'rich-textarea',
  'textarea[placeholder*="prompt" i]',
  'textarea[aria-label*="prompt" i]',
  'div[aria-label*="Enter a prompt" i]',
  '[data-placeholder*="Enter a prompt" i]',
  '[contenteditable="true"]',
];

const SEND_SELECTORS = [
  'button[aria-label*="Send" i]',
  '[role="button"][aria-label*="Send" i]',
  'button[data-tooltip*="Send" i]',
  'button[type="submit"]',
];

const RESPONSE_SELECTORS = [
  'model-response',
  '[data-message-author-role="model"]',
  '[data-role="model"]',
  '.model-response-text',
  '[class*="model-response"]',
  '[class*="message-content"]',
];

const STOP_SELECTORS = [
  'button[aria-label*="Stop" i]',
  '[role="button"][aria-label*="Stop" i]',
  'button:has-text("Stop")',
];

async function visibleCandidate(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

export async function findComposer(page: Page, timeoutMs = 60_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const direct = await visibleCandidate(page, COMPOSER_SELECTORS);
    if (direct) return direct;
    await page.waitForTimeout(500);
  }
  throw new Error(
    'Could not find the Gemini web composer. Open gemini.google.com, sign in, and leave the chat page open.',
  );
}


async function attachImages(page: Page, images: string[]): Promise<void> {
  if (!images.length) return;
  let input = page.locator('input[type="file"]').first();
  if (!(await input.count().catch(() => 0))) {
    const add = await visibleCandidate(page, [
      'button[aria-label*="Add files" i]',
      '[role="button"][aria-label*="Add files" i]',
      'button[aria-label*="Upload" i]',
      '[role="button"][aria-label*="Upload" i]',
    ]);
    if (add) await add.click().catch(() => undefined);
    await page.waitForTimeout(300);
    input = page.locator('input[type="file"]').first();
  }
  if (!(await input.count().catch(() => 0))) throw new Error('Gemini web file picker was not found.');
  await input.setInputFiles(images.slice(0, 4));
  await page.waitForTimeout(700);
}

async function composerText(box: Locator): Promise<string> {
  const value = await box.inputValue().catch(() => null);
  if (value !== null) return value;
  return (await box.innerText().catch(() => '')) ?? '';
}

async function clickSend(page: Page): Promise<boolean> {
  const button = await visibleCandidate(page, SEND_SELECTORS);
  if (!button) return false;
  const disabled = await button.isDisabled().catch(() => false);
  if (disabled) return false;
  await button.click().catch(() => undefined);
  return true;
}

async function assistantNodes(page: Page): Promise<{ count: number; lastText: string }> {
  for (const selector of RESPONSE_SELECTORS) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    let lastText = '';
    for (let i = count - 1; i >= 0; i--) {
      const node = loc.nth(i);
      if (!(await node.isVisible().catch(() => false))) continue;
      const text = (await node.innerText().catch(() => '')).trim();
      if (text) { lastText = text; break; }
    }
    if (lastText) return { count, lastText };
  }
  return { count: 0, lastText: '' };
}

export interface GeminiAssistantSnapshot {
  count: number;
  lastText: string;
}

export async function snapshotAssistant(page: Page): Promise<GeminiAssistantSnapshot> {
  return assistantNodes(page);
}

async function pageLooksSignedOut(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes('accounts.google.com') || /\/(signin|login|challenge)\b/.test(url)) return true;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/sign in|log in|create account|choose an account|verify it's you|couldn't sign you in/.test(body)) {
    return true;
  }
  return false;
}

async function hasSignedInAccountMarker(page: Page): Promise<boolean> {
  const accountSelectors = [
    '[aria-label*="Google Account" i]',
    '[aria-label*="Google account" i]',
    '[aria-label*="Account" i][role="button"]',
    'a[href*="SignOutOptions"]',
    'a[href*="Logout"]',
    '[data-email]',
  ];
  return Boolean(await visibleCandidate(page, accountSelectors));
}

async function hasGoogleSessionCookie(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies([
    'https://gemini.google.com/',
    'https://accounts.google.com/',
  ]).catch(() => []);
  const authCookieNames = new Set([
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LSID',
    '__Secure-1PSID', '__Secure-3PSID', '__Host-1PSID', '__Host-3PSID',
  ]);
  return cookies.some(cookie => authCookieNames.has(cookie.name));
}

/**
 * Verify an actual Gemini web login. A composer alone is NOT sufficient:
 * Gemini can render editable controls on logged-out/landing pages too.
 */
export async function isGeminiLoggedIn(page: Page): Promise<boolean> {
  if (await pageLooksSignedOut(page)) return false;
  const composer = await visibleCandidate(page, COMPOSER_SELECTORS);
  if (!composer) return false;
  const accountMarker = await hasSignedInAccountMarker(page);
  const sessionCookie = await hasGoogleSessionCookie(page);
  return accountMarker || sessionCookie;
}

export async function ensureLoggedIn(page: Page): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (await isGeminiLoggedIn(page)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(
    'Gemini web login was not verified. Sign in to your Google account in the opened browser window and wait for Gemini to return to the chat page.',
  );
}

export async function sendPrompt(page: Page, prompt: string, images: string[] = []): Promise<void> {
  await attachImages(page, images);
  const box = await findComposer(page, 60_000);
  await box.click();
  await page.waitForTimeout(150);
  await box.press('Control+A').catch(() => undefined);
  await box.press('Backspace').catch(() => undefined);
  await box.fill(prompt);
  await page.waitForTimeout(250);

  for (let attempt = 0; attempt < 4; attempt++) {
    await box.press('Enter').catch(() => undefined);
    await page.waitForTimeout(900);
    if (!(await composerText(box)).trim()) return;
    await clickSend(page);
    await page.waitForTimeout(900);
    if (!(await composerText(box)).trim()) return;
    await page.waitForTimeout(700 * (attempt + 1));
  }
  throw new Error('Timed out sending message to Gemini web (composer did not clear).');
}

export async function waitForCompleteResponse(
  page: Page,
  idleMs: number,
  timeoutMs: number,
  before: GeminiAssistantSnapshot,
  signal?: AbortSignal,
): Promise<string> {
  const start = Date.now();
  let last = '';
  let stableSince = Date.now();
  let lastActivity = Date.now();
  const stallMs = 45_000;

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('interrupted');
    const observed = await assistantNodes(page);
    const stopVisible = await visibleCandidate(page, STOP_SELECTORS);
    if (stopVisible) lastActivity = Date.now();

    const isNew = observed.count > before.count || (observed.lastText && observed.lastText !== before.lastText);
    if (isNew && observed.lastText !== last) {
      last = observed.lastText;
      stableSince = Date.now();
      lastActivity = Date.now();
    }

    if (last && !stopVisible && Date.now() - stableSince >= idleMs) return last;
    if (!stopVisible && Date.now() - lastActivity >= stallMs) {
      throw new Error('Timed out waiting for Gemini web response (stalled).');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for Gemini web response.');
}

function onOldConversation(page: Page): boolean {
  const url = new URL(page.url());
  return /\/app\//.test(url.pathname) || /\/chat\//.test(url.pathname);
}

export async function startNewChat(page: Page): Promise<void> {
  const newChat = await visibleCandidate(page, [
    'button:has-text("New chat")',
    '[role="button"]:has-text("New chat")',
    'a:has-text("New chat")',
    'button[aria-label*="New chat" i]',
  ]);
  if (newChat) {
    await newChat.click().catch(() => undefined);
    await page.waitForTimeout(800);
    if (!onOldConversation(page)) return;
  }
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
}

export async function openChatByUrl(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
}

export function currentChatUrl(page: Page): string {
  return page.url();
}
