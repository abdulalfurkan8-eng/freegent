import test from 'node:test';
import assert from 'node:assert/strict';
import { isApplicationScriptAutomationCommand } from './terminal/exec.js';

test('blocks Blender application scripting', () => {
  assert.equal(isApplicationScriptAutomationCommand('blender --background --python rocket_build.py'), true);
  assert.equal(isApplicationScriptAutomationCommand('blender --python-expr "print(1)"'), true);
});

test('allows normal GUI launch commands', () => {
  assert.equal(isApplicationScriptAutomationCommand('start blender'), false);
  assert.equal(isApplicationScriptAutomationCommand('blender.exe'), false);
});
