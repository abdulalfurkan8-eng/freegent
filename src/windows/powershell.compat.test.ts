import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function startupBlock(source: string): string {
  const start = source.indexOf("Add-Type @'");
  const end = source.indexOf("'@", start + 10);
  assert.ok(start >= 0 && end > start, 'embedded C# startup block not found');
  return source.slice(start, end);
}

test('embedded C# remains compatible with the Windows PowerShell 5.1 floor', async () => {
  const source = await readFile(new URL('./powershell.ts', import.meta.url), 'utf8');
  const cs = startupBlock(source);
  assert.doesNotMatch(cs, /\busing\s+var\b/);
  assert.doesNotMatch(cs, /\bConvert\.ToHexString\b/);
  assert.doesNotMatch(cs, /\bOverlayForm\?/);
  assert.doesNotMatch(cs, /\$"/);
});
