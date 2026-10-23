// A small, dependency-free MRZ (Machine Readable Zone) reader for passports (TD3) and ID cards (TD1/TD2),
// per ICAO 9303. It takes raw OCR text, finds the MRZ lines, validates the check digits, and returns the
// fields we fill a rental application with. Keeping it here (not an npm package) avoids an ESM/CommonJS
// clash and keeps the parser unit-testable on its own. The check digits let us reject OCR noise.

/** ICAO value of a MRZ character: digit → itself, A–Z → 10–35, filler '<' → 0. */
function charValue(c: string): number | null {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  if (c === '<') return 0;
  return null;
}
/** ICAO check digit over a field: weights cycle 7,3,1. Returns the expected digit, or null on bad input. */
function checkDigit(field: string): number | null {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]);
    if (v === null) return null;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}
/** True when `field`'s trailing check digit `digit` matches (digit may be '<' meaning 0/unused). */
function checks(field: string, digit: string): boolean {
  const expected = checkDigit(field);
  const actual = digit === '<' ? 0 : charValue(digit);
  return expected !== null && actual !== null && expected === actual;
}
/** "KARIMOV<<AZIZ<BEKZOD" → { lastName:'KARIMOV', firstName:'AZIZ BEKZOD' }. */
function names(field: string): { lastName: string; firstName: string } {
  const [primary = '', secondary = ''] = field.split('<<');
  const clean = (s: string) => s.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  return { lastName: clean(primary), firstName: clean(secondary) };
}
/** YYMMDD → YYYY-MM-DD, choosing the century so a date of birth never lands in the future. */
export function mrzDate(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4), dd = +yymmdd.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const currentYY = new Date().getUTCFullYear() % 100;
  const year = yy <= currentYY ? 2000 + yy : 1900 + yy;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export interface MrzResult {
  format: 'TD1' | 'TD2' | 'TD3';
  documentNumber: string;
  lastName: string;
  firstName: string;
  birthDate: string | null; // YYYY-MM-DD
  nationality: string;
  personalNumber: string; // digits only, where present (UZB ID cards carry the 14-digit PINFL here)
  /** Each true only when that field's own check digit matched — lets the caller trust fields one by one. */
  valid: { documentNumber: boolean; birthDate: boolean };
}

/** Keep only MRZ characters, upper-cased; OCR often adds spaces, lower case and stray punctuation. */
const normalize = (line: string) => line.toUpperCase().replace(/[^A-Z0-9<]/g, '');
/** Pad with filler or trim so a nearly-right OCR line becomes exactly `len` long. */
const fit = (line: string, len: number) => (line.length >= len ? line.slice(0, len) : line.padEnd(len, '<'));

function parseTD3(l1: string, l2: string): MrzResult {
  const docRaw = l2.slice(0, 9);
  return {
    format: 'TD3',
    documentNumber: docRaw.replace(/<+$/, ''),
    nationality: l2.slice(10, 13).replace(/</g, ''),
    birthDate: mrzDate(l2.slice(13, 19)),
    personalNumber: l2.slice(28, 42).replace(/[^0-9]/g, ''),
    ...names(l1.slice(5)),
    valid: { documentNumber: checks(docRaw, l2[9]), birthDate: checks(l2.slice(13, 19), l2[19]) },
  };
}
function parseTD2(l1: string, l2: string): MrzResult {
  const docRaw = l2.slice(0, 9);
  return {
    format: 'TD2',
    documentNumber: docRaw.replace(/<+$/, ''),
    nationality: l2.slice(10, 13).replace(/</g, ''),
    birthDate: mrzDate(l2.slice(13, 19)),
    personalNumber: l2.slice(28, 35).replace(/[^0-9]/g, ''),
    ...names(l1.slice(5)),
    valid: { documentNumber: checks(docRaw, l2[9]), birthDate: checks(l2.slice(13, 19), l2[19]) },
  };
}
function parseTD1(l1: string, l2: string, l3: string): MrzResult {
  const docRaw = l1.slice(5, 14);
  // UZB ID cards carry the 14-digit PINFL in the optional data; take the first 14-digit run we find.
  const optional = (l1.slice(15, 30) + l2.slice(18, 29)).match(/\d{14}/);
  return {
    format: 'TD1',
    documentNumber: docRaw.replace(/<+$/, ''),
    nationality: l2.slice(15, 18).replace(/</g, ''),
    birthDate: mrzDate(l2.slice(0, 6)),
    personalNumber: optional ? optional[0] : '',
    ...names(l3),
    valid: { documentNumber: checks(docRaw, l1[14]), birthDate: checks(l2.slice(0, 6), l2[6]) },
  };
}

/**
 * Find and parse an MRZ anywhere in `text`. Tries TD1 (3×30), TD3 (2×44) and TD2 (2×36) on runs of
 * consecutive MRZ-looking lines. Returns the first parse whose document-number check digit holds, so OCR
 * noise elsewhere on the page is ignored; null when no valid MRZ is present.
 */
export function parseMrz(text: string): MrzResult | null {
  const lines = text.split(/\r?\n/).map(normalize).filter(l => l.length >= 28 && /^[A-Z0-9<]+$/.test(l));
  let fallback: MrzResult | null = null;
  const consider = (r: MrzResult) => {
    if (r.valid.documentNumber && r.documentNumber) return r; // trust it outright
    if (!fallback && r.documentNumber) fallback = r; // keep as a maybe
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    // TD1 (ID cards): three lines around 30. Tried first so a real ID card is read as TD1, not as a passport.
    if (i + 2 < lines.length && [lines[i], lines[i + 1], lines[i + 2]].every(l => l.length >= 26 && l.length <= 34)) {
      const r = consider(parseTD1(fit(lines[i], 30), fit(lines[i + 1], 30), fit(lines[i + 2], 30)));
      if (r) return r;
    }
    // TD3 (passports) / TD2: two lines. OCR often loses the trailing '<' fillers, so a line can come back well
    // short of 44/36 — pad it to width and let the check digits confirm. The document number and birth date sit
    // in the same fixed early positions for TD2 and TD3, so even a shortened data line still parses.
    if (i + 1 < lines.length) {
      const a = lines[i], b = lines[i + 1];
      const r = consider(parseTD3(fit(a, 44), fit(b, 44))) || consider(parseTD2(fit(a, 36), fit(b, 36)));
      if (r) return r;
    }
  }
  return fallback;
}

export interface PassportFields { fullName?: string; passportSeries?: string; passportNumber?: string; dateOfBirth?: string; pinfl?: string; }
/** Turn an MRZ parse into the application's passport fields. Only emits a value when it is well-formed. */
export function mrzToFields(r: MrzResult): PassportFields {
  const out: PassportFields = {};
  const title = (s: string) => s.toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
  const name = [r.lastName, r.firstName].filter(Boolean).map(title).join(' ').trim();
  if (name) out.fullName = name;
  // UZB passport document number is 2 letters + 7 digits (e.g. AA1234567); split into series + number.
  const m = r.documentNumber.match(/^([A-Z]{2})(\d{7})$/);
  if (r.valid.documentNumber && m) { out.passportSeries = m[1]; out.passportNumber = m[2]; }
  if (r.valid.birthDate && r.birthDate) out.dateOfBirth = r.birthDate;
  if (/^\d{14}$/.test(r.personalNumber)) out.pinfl = r.personalNumber;
  return out;
}
