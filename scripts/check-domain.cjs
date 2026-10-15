// Deploy check of the own-domain listener (gateway:8082, docs/M7.1-DOMAIN.md), run inside the API container:
//   node scripts/check-domain.cjs <domain> [gateway-url]
// Sends the Host headers Cloudflare Tunnel sends, so it works before the tunnel exists. Exits 1 on the first
// broken rule.
const domain = process.argv[2];
const base = process.argv[3] || 'http://gateway:8082';
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain || '')) { console.error('domain required'); process.exit(2); }
const admin = `admin.${domain}`;
const http = require('node:http');

// fetch() drops a custom Host header, so plain http.request: no redirects followed, body discarded.
function get(host, path, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { headers: { Host: host, ...extra }, timeout: 15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (body.length < 4096) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const rules = [
  // Public domain: application form, invites, resident app, API for phones; never the health check or webhook.
  [domain, '/', 302, '/apply'],
  [domain, '/apply', 200],
  [domain, '/invite', 200],
  [domain, '/app', 200],
  [domain, '/app/ijara360.apk', 200],
  [domain, '/api/public/applications/config', 200],
  [domain, '/api/health', 404],
  [domain, '/api/telegram/webhook', 404],
  // Staff pages live behind Cloudflare Access on admin.<domain>.
  [domain, '/login', 302, `https://${admin}/login`],
  [domain, '/residents?x=1', 302, `https://${admin}/residents?x=1`],
  [domain, '/map', 302, `https://${admin}/map`],
  [`www.${domain}`, '/apply', 308, `https://${domain}/apply`],
  [admin, '/login', 200],
  [admin, '/api/health', 404],
];

(async () => {
  for (const [host, path, status, location] of rules) {
    const r = await get(host, path);
    const loc = r.location;
    if (r.status !== status || (location && loc !== location)) {
      console.error(`DOMAIN CHECK FAIL ${host}${path}: ${r.status}${loc ? ' -> ' + loc : ''}, expected ${status}${location ? ' -> ' + location : ''}`);
      process.exit(1);
    }
  }
  // Whatever the client claims, this entrance is the internet.
  for (const host of [domain, admin]) {
    const { body } = await get(host, '/api/auth/channel', { 'X-Ijara-Channel': 'private' });
    if (!body.includes('"internet":true')) { console.error(`DOMAIN CHECK FAIL ${host}: channel is not internet`); process.exit(1); }
  }
  console.log(`domain listener ok (${domain}, ${admin})`);
})().catch(e => { console.error('DOMAIN CHECK FAIL', e.message); process.exit(1); });
