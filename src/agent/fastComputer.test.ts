import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFastComputerTask } from './fastComputer.js';

test('fast lane accepts exact known app opens', () => {
  assert.deepEqual(matchFastComputerTask('open Blender'), { kind: 'open', app: 'blender.exe' });
  assert.deepEqual(matchFastComputerTask('open VS Code'), { kind: 'open', app: 'code' });
});

test('fast lane does not swallow complex open tasks', () => {
  assert.equal(matchFastComputerTask('open Blender and make a 3D rocket'), null);
  assert.equal(matchFastComputerTask('open WhatsApp and find yahoo then message hi'), null);
  assert.equal(matchFastComputerTask('open Blender and color it'), null);
});

test('fast lane still recognizes type and press commands', () => {
  assert.deepEqual(matchFastComputerTask('type: hello'), { kind: 'type', text: 'hello' });
  assert.deepEqual(matchFastComputerTask('press Enter'), { kind: 'press', key: 'Enter' });
});
