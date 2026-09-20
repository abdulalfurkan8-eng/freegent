import { execa } from 'execa';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { access } from 'node:fs/promises';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/**
 * Launch a GUI app, wait for its window, capture the SCREEN to a PNG, kill
 * the app, and attach the image to the chat - so the model can actually SEE
 * the interface it is building and judge it visually.
 */
export async function screenshotTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (process.platform !== 'win32') {
    return fail('screenshot: currently supported on Windows only');
  }
  const command = String(call.command ?? '');
  const waitMs = Math.min(Math.max(Number(call.waitMs) || 6000, 1500), 20_000);
  const out = join(tmpdir(), `freegent-shot-${Date.now()}.png`);

  let child: ReturnType<typeof execa> | null = null;
  if (command) {
    child = execa(command, { cwd: ctx.cwd, shell: true, reject: false });
    await new Promise((r) => setTimeout(r, waitMs));
    if (child.exitCode !== null && child.exitCode !== 0) {
      const res = await child;
      return fail(
        `screenshot: app crashed before capture (exit ${child.exitCode}):\n` +
          `${(res.all ?? res.stderr ?? '').toString().slice(0, 3000)}`,
      );
    }
  }

  const psPath = out.split(String.fromCharCode(92)).join('/');
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    `$bmp.Save('${psPath}',[System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = await execa('powershell', ['-NoProfile', '-STA', '-Command', script], {
    reject: false,
    timeout: 30_000,
  });

  if (child?.pid) {
    void execa('taskkill', ['/pid', String(child.pid), '/T', '/F'], { reject: false });
  }

  try {
    await access(out);
  } catch {
    return fail(`screenshot: capture failed: ${r.stderr || 'no image produced'}`);
  }
  ctx.attachImage?.(out);
  return ok(
    `Screenshot captured${command ? ` after running "${command}" for ${waitMs}ms` : ''} ` +
      '(app was stopped after capture). The image is ATTACHED to this message - ' +
      'LOOK at it and judge the real GUI: layout, colors, spacing, whether your ' +
      'changes are actually visible. If it looks wrong or unchanged, find out why.',
  );
}