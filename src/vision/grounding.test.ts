import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseGroundTarget, type GroundTarget } from './grounding.js';

const target = (overrides: Partial<GroundTarget> = {}): GroundTarget => ({
  text: 'Save', type: 'Button', bbox: [10, 20, 80, 30], confidence: 0.9,
  source: 'uia', timestamp: Date.now(), screenHash: 'frame-a', ...overrides,
});

test('grounding requires exact current screen hash', () => {
  assert.equal(chooseGroundTarget([target({ screenHash: 'old' })], 'Save', 10_000, 'frame-a'), null);
  assert.ok(chooseGroundTarget([target()], 'Save', 10_000, 'frame-a'));
});

test('grounding rejects stale, low-confidence, and future targets', () => {
  assert.equal(chooseGroundTarget([target({ timestamp: Date.now() - 20_000 })], 'Save', 10_000, 'frame-a'), null);
  assert.equal(chooseGroundTarget([target({ confidence: 0.2 })], 'Save', 10_000, 'frame-a'), null);
  assert.equal(chooseGroundTarget([target({ timestamp: Date.now() + 1_000 })], 'Save', 10_000, 'frame-a'), null);
});

test('grounding can enforce the requested point is inside the target', () => {
  assert.ok(chooseGroundTarget([target()], '', 10_000, 'frame-a', 0.45, [20, 30]));
  assert.equal(chooseGroundTarget([target()], '', 10_000, 'frame-a', 0.45, [500, 500]), null);
});
