const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const sharp = require('sharp');
const { PassportOcrService } = require('../dist/passport-ocr');

// Only runs where Tesseract is installed (the API image); skipped on a bare dev machine.
let hasTesseract = false;
try { execSync('tesseract --version', { stdio: 'ignore' }); hasTesseract = true; } catch {}

const val = c => (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : 0);
const cd = f => { const w = [7, 3, 1]; let s = 0; for (let i = 0; i < f.length; i++) s += val(f[i]) * w[i % 3]; return String(s % 10); };
const pad = (s, n) => s.padEnd(n, '<').slice(0, n);

/** Render two MRZ lines as a crisp black-on-white PNG, the way a clean scan would look. */
async function mrzImage(l1, l2) {
  const esc = s => s.replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="460">
    <rect width="100%" height="100%" fill="white"/>
    <text x="40" y="200" font-family="DejaVu Sans Mono, monospace" font-size="64" letter-spacing="6" fill="black" xml:space="preserve">${esc(l1)}</text>
    <text x="40" y="340" font-family="DejaVu Sans Mono, monospace" font-size="64" letter-spacing="6" fill="black" xml:space="preserve">${esc(l2)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('reads a clean passport MRZ image end to end', { skip: hasTesseract ? false : 'tesseract not installed' }, async () => {
  const doc = 'AA1234567', birth = '900101';
  const l1 = pad('P<UZBKARIMOV<<AZIZ<BEKZOD', 44);
  let l2 = doc + cd(doc) + 'UZB' + birth + cd(birth) + 'M' + '300101' + cd('300101') + pad('', 14);
  l2 = pad(l2, 43) + '0';
  const fields = await new PassportOcrService().scan(await mrzImage(l1, l2));
  assert.ok(fields, 'something was read');
  assert.equal(fields.passportSeries, 'AA');
  assert.equal(fields.passportNumber, '1234567');
  assert.equal(fields.dateOfBirth, '1990-01-01');
  assert.match(fields.fullName, /Karimov/);
});

test('a photo with no MRZ yields null and never throws', { skip: hasTesseract ? false : 'tesseract not installed' }, async () => {
  const blank = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 230, g: 230, b: 230 } } }).png().toBuffer();
  assert.equal(await new PassportOcrService().scan(blank), null);
});
