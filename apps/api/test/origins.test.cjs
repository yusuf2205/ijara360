const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedOrigins } = require('../dist/origins');

test('explicit LAN and Tailscale origins; no subdomains, port changes or missing origins', () => {
  const lan = 'https://192.168.1.105:8446';
  const remote = 'https://mynas.tail4bf75c.ts.net:8446';
  const allowed = allowedOrigins(lan, ` ${remote}, `, true);
  assert.deepEqual([...allowed], [lan, remote]);
  for (const rejected of ['', 'null', `${remote}.evil.invalid`, 'https://mynas.tail4bf75c.ts.net', 'https://evil.invalid']) {
    assert.equal(allowed.has(rejected), false);
  }
});
test('production rejects insecure, wildcard and non-origin configuration', () => {
  for (const rejected of ['http://localhost:3000', '*', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com/']) {
    assert.throws(() => allowedOrigins('https://example.com', rejected, true));
  }
  assert.equal(allowedOrigins('http://localhost:3000').has('http://localhost:3000'), true);
});
