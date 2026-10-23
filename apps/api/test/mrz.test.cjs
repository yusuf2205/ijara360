const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMrz, mrzToFields, mrzDate } = require('../dist/mrz');

// Build a valid check digit the way ICAO 9303 does, so tests can construct real-looking MRZ lines.
const val = c => (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : 0);
const cd = field => { const w = [7, 3, 1]; let s = 0; for (let i = 0; i < field.length; i++) s += val(field[i]) * w[i % 3]; return String(s % 10); };
const pad = (s, n) => s.padEnd(n, '<').slice(0, n);

test('ICAO 9303 canonical passport example parses with valid check digits', () => {
  const l1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
  const l2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';
  const r = parseMrz(`${l1}\n${l2}`);
  assert.ok(r, 'parsed');
  assert.equal(r.format, 'TD3');
  assert.equal(r.documentNumber, 'L898902C3');
  assert.equal(r.valid.documentNumber, true);
  assert.equal(r.valid.birthDate, true);
  assert.equal(r.lastName, 'ERIKSSON');
  assert.equal(r.firstName, 'ANNA MARIA');
  assert.equal(r.birthDate, '1974-08-12');
});

test('Uzbek passport (TD3): series, number, name, birth date are extracted', () => {
  const doc = 'AA1234567';
  const birth = '900101'; // 1990-01-01
  const l1 = pad('P<UZBKARIMOV<<AZIZ<BEKZOD', 44);
  const personal = '31234567890123'; // 14 digits
  let l2 = doc + cd(doc) + 'UZB' + birth + cd(birth) + 'M' + '300101' + cd('300101') + personal + cd(personal);
  l2 = pad(l2, 43); l2 += cd(l2.replace(/ /g, '')); // composite (not checked by us) → fill to 44
  const f = mrzToFields(parseMrz(`${l1}\n${l2}`));
  assert.equal(f.passportSeries, 'AA');
  assert.equal(f.passportNumber, '1234567');
  assert.equal(f.dateOfBirth, '1990-01-01');
  assert.equal(f.fullName, 'Karimov Aziz Bekzod');
  assert.equal(f.pinfl, '31234567890123');
});

test('Uzbek ID card (TD1): PINFL comes from the optional data, number splits into series+number', () => {
  const doc = 'AD1234567';
  const pinfl = '51234567890123';
  const birth = '000229'; // 2000-02-29 (a real leap day; century inferred as 2000s)
  const l1 = pad('IDUZB' + doc + cd(doc) + pinfl, 30);
  let l2 = birth + cd(birth) + 'M' + '350101' + cd('350101') + 'UZB';
  l2 = pad(l2, 29); l2 += cd(l2);
  const l3 = pad('KARIMOV<<AZIZ<BEKZOD', 30);
  const f = mrzToFields(parseMrz(`${l1}\n${l2}\n${l3}`));
  assert.equal(f.passportSeries, 'AD');
  assert.equal(f.passportNumber, '1234567');
  assert.equal(f.pinfl, pinfl);
  assert.equal(f.dateOfBirth, '2000-02-29');
  assert.equal(f.fullName, 'Karimov Aziz Bekzod');
});

test('tolerates OCR that dropped the trailing filler run (short MRZ lines)', () => {
  // Observed Tesseract output: the long '<<<<' tail is lost, so lines come back ~33 chars, not 44.
  const f = mrzToFields(parseMrz('P<UZBKARIMOV<<AZIZ<BEKZOD<<<<<<<<\nAA12345678UZB9001011M3001019<<<<<'));
  assert.equal(f.passportSeries, 'AA');
  assert.equal(f.passportNumber, '1234567');
  assert.equal(f.dateOfBirth, '1990-01-01');
  assert.equal(f.fullName, 'Karimov Aziz Bekzod');
});

test('MRZ is found inside noisy OCR text and surrounding junk is ignored', () => {
  const doc = 'AA7654321', birth = '850615';
  const l1 = pad('P<UZBTOSHMATOV<<JASUR', 44);
  let l2 = doc + cd(doc) + 'UZB' + birth + cd(birth) + 'M' + '320101' + cd('320101') + pad('', 14);
  l2 = pad(l2, 43) + '0';
  const noisy = `REPUBLIC OF UZBEKISTAN\nPASSPORT\nsome blurry line ~~~\n${l1}\n${l2}\nscanned 2026`;
  const f = mrzToFields(parseMrz(noisy));
  assert.equal(f.passportSeries, 'AA');
  assert.equal(f.passportNumber, '7654321');
  assert.equal(f.dateOfBirth, '1985-06-15');
});

test('a wrong document check digit is not trusted for auto-fill', () => {
  const doc = 'AA1234567', birth = '900101';
  const wrong = String((+cd(doc) + 1) % 10); // deliberately wrong
  const l1 = pad('P<UZBKARIMOV<<AZIZ', 44);
  let l2 = doc + wrong + 'UZB' + birth + cd(birth) + 'M' + '300101' + cd('300101') + pad('', 14);
  l2 = pad(l2, 44);
  const r = parseMrz(`${l1}\n${l2}`);
  assert.ok(r); // still returns a best-effort parse
  assert.equal(r.valid.documentNumber, false);
  const f = mrzToFields(r);
  assert.equal(f.passportSeries, undefined); // but series/number are withheld until the check digit holds
  assert.equal(f.passportNumber, undefined);
  assert.equal(f.dateOfBirth, '1990-01-01'); // birth date had a good check digit, so it is kept
});

test('mrzDate chooses a non-future century and rejects impossible dates', () => {
  assert.equal(mrzDate('740812'), '1974-08-12');
  assert.equal(mrzDate('000101'), '2000-01-01');
  assert.equal(mrzDate('991231'), '1999-12-31');
  assert.equal(mrzDate('901345'), null); // month 13
  assert.equal(mrzDate('ABCDEF'), null);
});

test('text without any MRZ returns null', () => {
  assert.equal(parseMrz('just some words\nno machine zone here'), null);
  assert.equal(parseMrz(''), null);
});
