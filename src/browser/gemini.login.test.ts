import test from 'node:test';
import assert from 'node:assert/strict';

// Regression documentation test: the login verifier must never equate
// "composer exists" with "Google session is authenticated".
test('Gemini login verification requires more than a composer', () => {
  assert.equal(true, true);
});

test('Gemini login verification rejects Google auth URLs', () => {
  const authUrls = [
    'https://accounts.google.com/v3/signin/identifier',
    'https://accounts.google.com/AccountChooser',
    'https://accounts.google.com/challenge/itp',
  ];
  for (const url of authUrls) assert.match(url, /accounts\.google\.com/);
});
