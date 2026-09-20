import ora from 'ora';
import readline from 'node:readline';
import { join } from 'node:path';
import { loadConfig } from '../../config/config.js';
import { openSession, type BrowserSession } from '../../browser/session.js';
import { ensureLoggedIn as ensureDeepSeekLoggedIn, findComposer as findDeepSeekComposer } from '../../browser/deepseek.js';
import { startRemoteControl, remoteControlUrl } from '../../browser/remoteControl.js';
import { isTermux } from '../../utils/platform.js';
import { ROOT_DIR } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    if (hidden) {
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(question);
        else process.stdout.write('*');
      };
    }
  });
}

/** List visible inputs on the page (for headless debugging). */
async function inventory(page: BrowserSession['page']): Promise<string[]> {
  const seen: string[] = [];
  const inputs = page.locator('input');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const type = (await el.getAttribute('type').catch(() => null)) ?? 'text';
    const ph = (await el.getAttribute('placeholder').catch(() => null)) ?? '';
    seen.push(`input[type=${type}] placeholder="${ph}"`);
  }
  return seen;
}

/** Termux: no visible browser - inspect the page, then fill the form. */
async function termuxLogin(session: BrowserSession): Promise<void> {
  const page = session.page;
  logger.info('Termux detected: headless login (no browser window on Android).');
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(5000); // slow mobile rendering

  logger.info(`Page URL: ${page.url()}`);
  logger.info(`Page title: ${await page.title().catch(() => '(unknown)')}`);
  const fields = await inventory(page);
  const shot1 = join(ROOT_DIR, 'login-debug-1.png');
  await page.screenshot({ path: shot1, fullPage: true }).catch(() => undefined);
  logger.info(`Screenshot saved: ${shot1}  (open it in your gallery to SEE the page)`);

  if (fields.length === 0) {
    logger.error('No visible input fields - likely a bot-check/captcha page.');
    logger.info('Check the screenshot. If it shows verification, use the PC fallback:');
    logger.info('log in on a PC once and copy ~/.freegent/profile to your phone.');
    throw new Error('Login form not found on page');
  }
  logger.info(`Visible fields:\n  ${fields.join('\n  ')}`);

  const email = await ask('DeepSeek email/phone: ');
  const password = await ask('Password: ', true);

  // First visible non-password input = identity field.
  const inputs = page.locator('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
  const count = await inputs.count();
  let filled = false;
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.fill(email, { timeout: 10_000 });
      filled = true;
      break;
    }
  }
  if (!filled) throw new Error('Could not find the email/phone field');
  await page.locator('input[type="password"]').first().fill(password, { timeout: 10_000 });

  // Agree-to-terms checkbox, if the form has one.
  const checkbox = page.locator('input[type="checkbox"]').first();
  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.check().catch(() => undefined);
  }

  const submit = page
    .locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), [role="button"]:has-text("Log in"), [role="button"]:has-text("Sign in")')
    .first();
  if (await submit.isVisible().catch(() => false)) await submit.click();
  else await page.locator('input[type="password"]').first().press('Enter');

  await page.waitForTimeout(6000);
  const shot2 = join(ROOT_DIR, 'login-debug-2.png');
  await page.screenshot({ path: shot2, fullPage: true }).catch(() => undefined);
  logger.info(`After submit: ${page.url()}`);
  logger.info(`Screenshot saved: ${shot2}`);
}

/** Open the browser and wait until DeepSeek is logged in. */
export async function loginCommand(opts: { remote?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  const spinner = ora({ text: 'Opening DeepSeek login...', discardStdin: false }).start();
  const session = await openSession(config, true);
  try {
    if (isTermux()) {
      spinner.stop();
      const already = await findDeepSeekComposer(session.page, 5_000).catch(() => null);
      if (!already) await termuxLogin(session);
      const wait = ora({ text: 'Waiting for DeepSeek session (Ctrl+C to abort)...', discardStdin: false }).start();
      await ensureDeepSeekLoggedIn(session.page);
      wait.succeed('Logged in! Starting remote control...');
      const remote = Boolean(opts.remote);
      const remoteCtl = await startRemoteControl(session.page, 7070, remote).catch(() => null);
      const stop = remoteCtl?.stop;
      const url  = remoteCtl?.url ?? remoteControlUrl(7070, '', remote);
      console.log('');
      console.log('  Open this URL in Chrome on your phone:');
      console.log('  ' + url);
      console.log('');
      console.log('  Enable DeepThink / Search, then press Enter here to save the session.');
      await new Promise<void>(r => {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question('', () => { rl2.close(); r(); });
      });
      if (stop) stop();
      console.log('  Session saved.');
    } else {
      spinner.text = 'Please log into DeepSeek in the opened browser window...';
      await ensureDeepSeekLoggedIn(session.page);
      spinner.succeed('Logged in! You have 30 seconds to enable Search / DeepThink in the browser.');
      for (let t = 30; t > 0; t--) {
        process.stdout.write('\r  Saving session in ' + t + 's... (click Search / DeepThink now)  ');
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.stdout.write('\r  Session saved.                                          \n');
    }
    logger.info('Future freegent runs will reuse this DeepSeek login session.');
  } finally {
    await session.close();
  }
}