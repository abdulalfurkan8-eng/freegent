import { chromium, type BrowserContext, type Page } from 'playwright';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PROFILE_DIR, ensureRoot } from '../utils/paths.js';
import { isTermux, findTermuxChromium, TERMUX_SETUP_HELP } from '../utils/platform.js';
import type { FreegentConfig } from '../config/config.js';
import { unsealProfile, sealProfile } from '../security/profileVault.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** Launch a persistent Chromium profile so the selected web provider login is reused. */
export async function openSession(
  config: FreegentConfig,
  headed: boolean,
): Promise<BrowserSession> {
  await ensureRoot();
  await unsealProfile();

  // Legacy CDP path (kept for debugging with chrome --remote-debugging-port).
  const cdp = process.env.FREEGENT_CDP;
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp, { timeout: 20_000 });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const findTab = (): Page | undefined =>
      ctx.pages().find((p) => p.url().includes('deepseek') || p.url().includes('gemini.google.com'));
    let page = findTab();
    for (let i = 0; i < 30 && !page; i++) {
      await new Promise((r) => setTimeout(r, 500));
      page = findTab();
    }
    if (!page) throw new Error('Provider tab not found in the app browser');
    const targetUrl = config.provider === 'gemini' ? config.geminiUrl : config.chatUrl;
    if (!page.url().startsWith(targetUrl)) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => { /* login redirects are fine */ });
    }
    return {
      context: ctx,
      page,
      async close() { await browser.close().catch(() => { /* detached */ }); await sealProfile().catch(() => undefined); },
    };
  }

  // PC/laptop path (unchanged): Playwright's bundled Chromium.
  let executablePath: string | undefined;
  let extraArgs: string[] = [];
  let headless = headed ? false : config.headless;
  let userAgent: string | undefined;

  if (headless) {
    // CloudFront 403-blocks "HeadlessChrome" - use a real desktop identity.
    const os =
      process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
    userAgent =
      `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      'Chrome/126.0.0.0 Safari/537.36';
  }

  if (isTermux()) {
    // Android/Termux: bundled Chromium cannot run - use the system package,
    // always headless (no display), sandbox off (required on Termux).
    const found = await findTermuxChromium();
    if (!found) {
      throw new Error(`Chromium not found on Termux.\n${TERMUX_SETUP_HELP}`);
    }
    executablePath = found;
    headless = true;
    extraArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    // CloudFront 403-blocks the default HeadlessChrome identity -
    // present as a normal desktop Chrome instead.
    userAgent =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  }

  let context: BrowserContext;
  const launchArgs = {
    headless,
    executablePath,
    viewport: { width: 1440, height: 960 },
    userAgent,
    args: ['--disable-blink-features=AutomationControlled', ...extraArgs],
  };
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchArgs);
  } catch (err) {
    // A prior run that didn't shut down cleanly (terminal closed instead of
    // /exit) can leave the profile's disk cache or singleton lock files in a
    // state Chromium refuses to reopen. Both are safe to clear - no login
    // session data lives there, only rebuildable cache/lock state - so wipe
    // them and retry once before giving up.
    const msg = (err as Error).message;
    if (/Cache_Data|SingletonLock|ProcessSingleton|already running|unknown error, open/i.test(msg)) {
      await Promise.all([
        rm(join(PROFILE_DIR, 'Default', 'Cache'), { recursive: true, force: true }).catch(() => undefined),
        rm(join(PROFILE_DIR, 'Default', 'Code Cache'), { recursive: true, force: true }).catch(() => undefined),
        rm(join(PROFILE_DIR, 'SingletonLock'), { force: true }).catch(() => undefined),
        rm(join(PROFILE_DIR, 'SingletonSocket'), { force: true }).catch(() => undefined),
        rm(join(PROFILE_DIR, 'SingletonCookie'), { force: true }).catch(() => undefined),
      ]);
      context = await chromium.launchPersistentContext(PROFILE_DIR, launchArgs);
    } else {
      throw err;
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  const targetUrl = config.provider === 'gemini' ? config.geminiUrl : config.chatUrl;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  return {
    context,
    page,
    async close() {
      await context.close();
      await sealProfile();
    },
  };
}