export function allowedOrigins(primary: string, additional = '', production = false): Set<string> {
  const origins = [primary, ...additional.split(',').map(value => value.trim()).filter(Boolean)];
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) {
      throw new Error('Application origins must be exact HTTP(S) origins; production requires HTTPS.');
    }
  }
  return new Set(origins);
}
