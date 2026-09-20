import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('CUA repair has no undefined bootstrap placeholders', async () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'powershell.ts');
  const source = await readFile(file, 'utf8');
  assert.match(source, /const CUA_REPAIR = WIN32_CSHARP;/);
  assert.doesNotMatch(source, /\$\{winclass\}/);
    assert.doesNotMatch(source, /\$\{overclass\}/);
  assert.doesNotMatch(source, /const CUA_REPAIR = String\.raw`[\s\S]*Add-Type -TypeDefinition/);
  assert.match(source, /\$freeGentRefs = @\(/);
  assert.match(source, /-ReferencedAssemblies \$freeGentRefs/);
  assert.match(source, /System\.Drawing\.Bitmap/);
  assert.match(source, /System\.Windows\.Forms\.Form/);

});
