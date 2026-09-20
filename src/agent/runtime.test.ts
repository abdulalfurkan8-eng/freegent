import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from './runtime.js';

test('runtime changes strategy after repeated identical failures', async () => {
  const r = new AgentRuntime(process.cwd());
  await r.start('test');
  const call = { intent: 'click Save', tool: 'computer' as const, risk: 'medium' as const };
  await r.beginAction(call);
  await r.result(false, 'not found', JSON.stringify({ tool:'computer', action:'click', x:1, y:2 }));
  await r.beginAction(call);
  await r.result(false, 'not found', JSON.stringify({ tool:'computer', action:'click', x:1, y:2 }));
  assert.equal(r.shouldChangeStrategy(), true);
  assert.match(r.recoveryGuidance(), /different strategy/i);
});

test('runtime context exposes current phase', async () => {
  const r = new AgentRuntime(process.cwd());
  await r.start('test');
  assert.match(r.context(), /understand/);
});
