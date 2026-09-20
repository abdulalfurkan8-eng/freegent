import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/**
 * Drive a real Android phone or an emulator (LDPlayer, BlueStacks, Android
 * Studio AVD) over ADB - the same way test_page drives a browser.
 */
const SHOT_DIR = '.freegent/phone';

interface Res { code: number; out: string; err: string }

async function adb(args: string[], ctx: ToolContext, timeout = 60_000): Promise<Res> {
  const { execa } = await import('execa');
  const serial = process.env.FREEGENT_ADB_SERIAL;
  const full = serial ? ['-s', serial, ...args] : args;
  const r = await execa('adb', full, {
    cwd: ctx.cwd, reject: false, timeout, cancelSignal: ctx.signal,
    encoding: 'utf8', maxBuffer: 12_000_000,
  }).catch((e: Error) => ({ exitCode: 127, stdout: '', stderr: e.message }));
  return {
    code: r.exitCode ?? 1, out: String(r.stdout ?? ''), err: String(r.stderr ?? ''),
  };
}

const NO_ADB =
  'phone: adb not found. Install Android Platform Tools and put adb on PATH, ' +
  'then plug in a phone with USB debugging ON, or start any emulator.';

/** Find an app package from a friendly name ("tiktok"). */
async function findPackage(name: string, ctx: ToolContext): Promise<string | null> {
  const q = name.toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (!q) return null;
  const r = await adb(['shell', 'pm', 'list', 'packages'], ctx, 30_000);
  const pkgs = r.out.split('\n').map((l) => l.replace('package:', '').trim())
    .filter(Boolean);
  return pkgs.find((p) => p === name)
    ?? pkgs.find((p) => p.toLowerCase().includes(q))
    ?? null;
}

export async function phoneTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const action = String(call.action ?? call.do ?? '').trim().toLowerCase();
  if (!action) {
    return fail('phone: "action" is required (connect|devices|open|tap|swipe|text|key|screenshot|screen|install|shell)');
  }
  const arg = (k: string): string => String(call[k] ?? '').trim();
  const num = (k: string): number => Number(call[k] ?? 0);

  if (action === 'connect') {
    // BlueStacks/LDPlayer/MEmu/Nox listen on their own ADB ports.
    const given = arg('address') || arg('host') || arg('port');
    const targets = given
      ? [given.includes(':') ? given : '127.0.0.1:' + given]
      : ['127.0.0.1:5555', '127.0.0.1:5565', '127.0.0.1:5575',
         '127.0.0.1:21503', '127.0.0.1:62001', '127.0.0.1:7555'];
    const tried: string[] = [];
    for (const t of targets) {
      const r = await adb(['connect', t], ctx, 15_000);
      if (r.code === 127) return fail(NO_ADB);
      if (/connected to/i.test(r.out)) {
        return ok('phone: connected to ' + t +
          '. Run phone/screen or phone/screenshot to see what is on it.');
      }
      tried.push(t);
    }
    return fail('phone: could not connect (tried ' + tried.join(', ') +
      '). In BlueStacks turn ON Settings > Advanced > Android Debug Bridge, ' +
      'then pass its port, e.g. {"action":"connect","port":"5555"}.');
  }

  if (action === 'devices') {
    const r = await adb(['devices', '-l'], ctx, 20_000);
    if (r.code === 127) return fail(NO_ADB);
    const lines = r.out.split('\n').slice(1).filter((l) => l.trim());
    if (lines.length === 0) {
      return fail('phone: no device. Plug in a phone (USB debugging ON, accept the popup) or start an emulator, then try again.');
    }
    return ok('phone: connected devices\n' + lines.join('\n'));
  }

  if (action === 'open' || action === 'launch') {
    const want = arg('app') || arg('package') || arg('name');
    if (!want) return fail('phone: which app? e.g. {"action":"open","app":"tiktok"}');
    const pkg = await findPackage(want, ctx);
    if (!pkg) return fail('phone: no installed app matches "' + want + '".');
    const r = await adb(['shell', 'monkey', '-p', pkg, '-c',
      'android.intent.category.LAUNCHER', '1'], ctx, 30_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone: launched ' + pkg + '. Take a screenshot to see the screen.');
  }

  if (action === 'tap' || action === 'click') {
    const r = await adb(['shell', 'input', 'tap',
      String(num('x')), String(num('y'))], ctx, 20_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone: tapped ' + num('x') + ',' + num('y'));
  }

  if (action === 'swipe' || action === 'scroll') {
    const ms = String(Math.min(Math.max(num('ms') || 300, 50), 5000));
    const r = await adb(['shell', 'input', 'swipe', String(num('x1')),
      String(num('y1')), String(num('x2')), String(num('y2')), ms], ctx, 20_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone: swiped');
  }

  if (action === 'text' || action === 'type') {
    const t = String(call.text ?? call.value ?? '');
    if (!t) return fail('phone: "text" is required');
    // input text wants %s for spaces; strip shell metacharacters
    const safe = t.replace(/[^A-Za-z0-9 @._:/,!?+-]/g, '').replace(/ /g, '%s');
    const r = await adb(['shell', 'input', 'text', safe], ctx, 20_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone: typed "' + t.slice(0, 60) + '"');
  }

  if (action === 'key') {
    const map: Record<string, string> = {
      back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER',
      search: 'KEYCODE_SEARCH', menu: 'KEYCODE_MENU',
      up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', delete: 'KEYCODE_DEL',
      recents: 'KEYCODE_APP_SWITCH',
    };
    const raw = arg('key').toLowerCase();
    const key = map[raw] ?? raw.toUpperCase().replace(/[^A-Z_]/g, '');
    if (!key) return fail('phone: "key" is required (back|home|enter|...)');
    const r = await adb(['shell', 'input', 'keyevent', key], ctx, 20_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone: pressed ' + key);
  }

  if (action === 'screenshot' || action === 'shot') {
    const dir = join(ctx.cwd, SHOT_DIR);
    await mkdir(dir, { recursive: true });
    const name = (arg('name') || 'screen').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
    const local = join(dir, name);
    const remote = '/sdcard/freegent-shot.png';
    const cap = await adb(['shell', 'screencap', '-p', remote], ctx, 60_000);
    if (cap.code === 127) return fail(NO_ADB);
    const pull = await adb(['pull', remote, local], ctx, 60_000);
    await adb(['shell', 'rm', remote], ctx, 20_000);
    if (pull.code !== 0) {
      return fail('phone: could not pull the screenshot: ' + pull.err.slice(0, 200));
    }
    ctx.attachImage?.(local);
    return ok('phone: screenshot saved to ' + SHOT_DIR + '/' + name +
      ' and ATTACHED - look at it, then tap the coordinates you see.');
  }

  if (action === 'screen' || action === 'dump' || action === 'ui') {
    const r = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], ctx, 60_000);
    if (r.code === 127) return fail(NO_ADB);
    // Condense the XML dump into "label -> tap x,y" lines the model can use.
    const items: string[] = [];
    const re = /text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.out)) !== null) {
      const label = m[1].trim();
      if (!label) continue;
      const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
      const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
      items.push('"' + label + '" -> tap ' + cx + ',' + cy);
      if (items.length >= 60) break;
    }
    if (items.length === 0) {
      return ok('phone: no readable text on screen (a game or video?). Take a screenshot and tap by pixel instead.');
    }
    return ok('phone: what is on screen now\n' + items.join('\n'));
  }

  if (action === 'install') {
    const apk = arg('apk') || arg('path');
    if (!apk) return fail('phone: "apk" path is required');
    const r = await adb(['install', '-r', join(ctx.cwd, apk)], ctx, 300_000);
    if (r.code === 127) return fail(NO_ADB);
    const out = (r.out + r.err).trim();
    return /success/i.test(out)
      ? ok('phone: installed ' + apk)
      : fail('phone: install failed:\n' + out.slice(0, 400));
  }

  if (action === 'shell') {
    const cmd = String(call.command ?? call.cmd ?? '');
    if (!cmd) return fail('phone: "command" is required');
    const r = await adb(['shell', cmd], ctx, 120_000);
    if (r.code === 127) return fail(NO_ADB);
    return ok('phone shell: ' + cmd + '\n' +
      ((r.out + r.err).slice(0, 4000) || '(no output)'));
  }

  return fail('phone: unknown action "' + action + '"');
}