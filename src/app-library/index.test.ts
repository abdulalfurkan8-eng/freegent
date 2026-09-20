import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APP_PROFILES } from './defaults.js';
import { formatAppLibraryContext, matchAppProfiles, matchAppProfilesDetailed } from './index.js';

test('built-in App Library contains common Windows apps', () => {
  const ids = new Set(DEFAULT_APP_PROFILES.map(p => p.id));
  for (const id of ['blender', 'vscode', 'notepad', 'chrome', 'edge', 'explorer', 'terminal', 'powershell', 'paint', 'calculator', 'whatsapp']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test('App Library matches Blender by task', async () => {
  const matches = await matchAppProfiles('open Blender and make a rocket');
  assert.equal(matches[0]?.id, 'blender');
});

test('App Library matches active process even when task is generic', async () => {
  const matches = await matchAppProfiles('click the save button', { process: 'blender', title: 'Blender' });
  assert.equal(matches[0]?.id, 'blender');
});

test('App Library context tells the model to verify baseline workflows', () => {
  const text = formatAppLibraryContext([DEFAULT_APP_PROFILES[0]], { process: 'blender', title: 'Blender' }, 'open Blender and make a house use colour');
  assert.match(text, /App Library/);
  assert.match(text, /baseline knowledge/);
  assert.match(text, /F3/);
  assert.match(text, /ACTIVE CONTROL PROFILE/);
  assert.match(text, /PRIMARY MATCH/);
  assert.match(text, /Recommended workflows for this task/);
});

test('Blender task uses a strong primary profile without generic model/material false positives', async () => {
  const matches = await matchAppProfilesDetailed('make a 3D model with materials');
  assert.equal(matches[0]?.profile.id, 'blender');
  assert.ok(matches[0]?.confidence >= 70);
});

test('Foreground Blender wins over generic task wording', async () => {
  const matches = await matchAppProfilesDetailed('click the save button', { process: 'blender', title: '(Unsaved) - Blender 5.1.2' });
  assert.equal(matches[0]?.profile.id, 'blender');
  assert.ok(matches[0]!.confidence >= 94);
});

test('App Library control context is written as mandatory baseline guidance', () => {
  const text = formatAppLibraryContext([DEFAULT_APP_PROFILES[0]], { process: 'blender', title: 'Blender 5.1.2' }, 'open Blender and make a house use colour');
  assert.match(text, /MANDATORY APP-LIBRARY BEHAVIOR/);
  assert.match(text, /Do not ignore it/);
  assert.match(text, /Manual exploration is a fallback/);
});
