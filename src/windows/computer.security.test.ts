import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUiControlType } from './computer.js';

test('UIA control type accepts known ControlType members', () => {
  assert.equal(validateUiControlType('Button'), 'Button');
  assert.equal(validateUiControlType('Document'), 'Document');
});

test('UIA control type rejects PowerShell injection payloads', () => {
  assert.throws(
    () => validateUiControlType("Button); Start-Process calc; ('"),
    /Unsupported UIA control type/,
  );
});

test('UIA control type rejects unknown members', () => {
  assert.throws(() => validateUiControlType('NotAControlType'), /Unsupported UIA control type/);
});
