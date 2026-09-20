import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from './config.js';

test('defaults keep DeepSeek as the default provider', () => {
  assert.equal(DEFAULT_CONFIG.provider, 'deepseek');
});

test('Gemini uses the web provider URL and no API-key setting', () => {
  assert.equal(DEFAULT_CONFIG.geminiUrl, 'https://gemini.google.com/');
  assert.equal(DEFAULT_CONFIG.geminiModel, 'Gemini web');
});
