import test from 'node:test';
import assert from 'node:assert/strict';
import { isDetachedGuiLaunchCommand } from './exec.js';

test('GUI launches are detached on Windows only', () => {
  assert.equal(isDetachedGuiLaunchCommand('"C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" "rocket.blend"', 'win32'), true);
  assert.equal(isDetachedGuiLaunchCommand('notepad.exe', 'win32'), true);
  assert.equal(isDetachedGuiLaunchCommand('node server.js', 'win32'), false);
});

test('non-GUI commands are not treated as detached desktop apps', () => {
  assert.equal(isDetachedGuiLaunchCommand('npm run build', 'win32'), false);
  assert.equal(isDetachedGuiLaunchCommand('powershell -NoProfile -Command "Write-Output ok"', 'win32'), false);
  assert.equal(isDetachedGuiLaunchCommand('notepad.exe', 'linux'), false);
});
