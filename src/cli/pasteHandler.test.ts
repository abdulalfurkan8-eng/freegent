import test from 'node:test'; import assert from 'node:assert/strict'; import { PasteHandler } from './pasteHandler.js';
test('stores multiline paste and expands it',()=>{const p=new PasteHandler();const chip=p.add('a\nb');assert.equal(chip,'[paste#1: 2 lines]');assert.equal(p.expand(chip),'a\nb');});
test('keeps single-line paste inline',()=>{const p=new PasteHandler();assert.equal(p.add('hello'),'hello');});
