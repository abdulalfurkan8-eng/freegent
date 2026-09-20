import { execa } from 'execa';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { access } from 'node:fs/promises';

/**
 * Save the current clipboard image to a temp PNG file.
 * Returns the file path, or null if the clipboard has no image.
 */
export async function saveClipboardImage(): Promise<string | null> {
  const file = join(tmpdir(), `freegent-paste-${Date.now()}.png`);

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$img = [System.Windows.Forms.Clipboard]::GetImage();',
      'if ($img -eq $null) { exit 1 };',
      `$img.Save('${file.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      'exit 0;',
    ].join(' ');
    const r = await execa('powershell', ['-NoProfile', '-STA', '-Command', script], {
      reject: false,
      timeout: 15000,
    });
    if (r.exitCode !== 0) return null;
  } else if (process.platform === 'darwin') {
    const script = `set p to POSIX file "${file}"
try
  set d to the clipboard as «class PNGf»
  set f to open for access p with write permission
  write d to f
  close access f
on error
  return 1
end try`;
    const r = await execa('osascript', ['-e', script], { reject: false, timeout: 15000 });
    if (r.exitCode !== 0) return null;
  } else {
    const r = await execa('sh', ['-c', `xclip -selection clipboard -t image/png -o > "${file}"`], {
      reject: false,
      timeout: 15000,
    });
    if (r.exitCode !== 0) return null;
  }

  try {
    await access(file);
    return file;
  } catch {
    return null;
  }
}