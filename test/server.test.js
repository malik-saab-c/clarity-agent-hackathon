const { test } = require('node:test');
const assert = require('node:assert');
process.env.CLARITY_TEST = '1';
const { safeCalc, makeZip, safePath, wsRoot } = require('../server.js');
const fs = require('fs');
const path = require('path');

test('safeCalc handles arithmetic', () => { assert.equal(safeCalc('10 + 5 * 2'), 20); });
test('safeCalc rejects unsafe input', () => { assert.throws(() => safeCalc('process.exit()'), /allowed/); });
test('makeZip produces valid zip (PK magic + central dir)', () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
test('safePath blocks traversal', () => { assert.throws(() => safePath('../etc/passwd'), /Invalid|escapes/); });
test('workspace dir exists', () => { assert.ok(fs.existsSync(wsRoot)); });
test('uploads dir exists', () => { assert.ok(fs.existsSync(path.join(wsRoot, 'uploads'))); });
test('provider registry includes all supported providers', () => {
  const { providers } = require('../server.js');
  for (const name of ['openai', 'groq', 'anthropic', 'gemini', 'local']) assert.ok(providers[name]);
});
