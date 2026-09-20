import test from 'node:test';
import assert from 'node:assert/strict';
import { rankStrategies } from './strategy.js';

test('GUI tasks prefer semantic UI and keyboard before visual fallback', () => {
  const r = rankStrategies('open Blender and click the Save menu');
  assert.equal(r[0].strategy, 'semantic-ui');
  assert.equal(r[1].strategy, 'keyboard');
});

test('coding tasks keep terminal high without forcing app scripting', () => {
  const r = rankStrategies('find and fix the TypeScript bug and run tests');
  assert.ok(r.find(x => x.strategy === 'terminal')!.score > r.find(x => x.strategy === 'application-automation')!.score);
});


test('complex open commands are not ranked as simple deterministic computer actions', () => {
  const r = rankStrategies('open Blender and make a 3D rocket');
  assert.ok(r[0].strategy !== 'semantic-ui' || r[0].score < 0.99);
});
