import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const makeToken = () => randomBytes(32).toString('base64url');
export function normalizePhone(input: string) {
  const phone = input.replace(/[\s()\-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new BadRequestException('Укажите телефон в международном формате, например +998901234567.');
  }
  return phone;
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, 64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hex] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !hex) return false;
  const key = await derive(password, salt);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export function safeTokenEqual(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
