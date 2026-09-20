import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinWorkspaceLexical } from './isolation.js';

test('workspace lexical guard rejects traversal and prefix collisions', () => {
  assert.equal(isWithinWorkspaceLexical('C:/work/app', 'src/a.ts'), true);
  assert.equal(isWithinWorkspaceLexical('C:/work/app', '../secret.txt'), false);
  assert.equal(isWithinWorkspaceLexical('C:/work/app', 'C:/work/app2/secret.txt'), false);
});
