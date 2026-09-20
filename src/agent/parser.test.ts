import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCall } from './parser.js';
test('parses raw write block without JSON escaping',()=>{const x=parseToolCall('```freegent\ntool: write_file\npath: a.ts\n<<<CONTENT\nconst x = "a";\nCONTENT>>>\n```');assert.equal(x?.tool,'write_file');assert.equal(x?.content,'const x = "a";');});
test('parses JSON fallback',()=>{const x=parseToolCall('```freegent {"tool":"read_file","path":"src/a.ts"} ```');assert.equal(x?.tool,'read_file');assert.equal(x?.path,'src/a.ts');});
test('parses YAML scalar summary',()=>{const x=parseToolCall('```freegent\ntool: finish\nsummary: |\n  line one\n  line two\n```');assert.equal(x?.summary,'line one\nline two');});
