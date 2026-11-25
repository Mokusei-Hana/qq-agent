import crypto from 'node:crypto';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  if (value === undefined || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) throw Error('Invalid canonical value');
  return JSON.stringify(value);
}
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
export function fail(code, status = 400) { const e = Error(code); e.code = code; e.status = status; throw e; }
