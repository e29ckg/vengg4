export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };
export function text(value, name, max = 255, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.length > max || !value.trim() || /[\x00]/.test(value)) fail(400, `${name} ไม่ถูกต้อง`);
  return value.trim();
}
export function integer(value, name = 'id', min = 1, max = 2147483647) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) fail(400, `${name} ไม่ถูกต้อง`);
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, `${name} ไม่ถูกต้อง`); return n;
}
export const flag = value => typeof value === 'boolean' ? Number(value) : integer(value, 'สถานะ', 0, 1);
export function month(value) { if (typeof value !== 'string' || !/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(value)) fail(400, 'เดือนต้องเป็น YYYY-MM'); return value; }
export function date(value) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, 'วันที่ไม่ถูกต้อง');
  return value;
}
export function password(value) { if (typeof value !== 'string' || Buffer.byteLength(value) < 12 || Buffer.byteLength(value) > 72 || value.includes('\0')) fail(400, 'รหัสผ่านต้องมี 12–72 UTF-8 bytes'); return value; }
export function array(value, max = 1000) { if (!Array.isArray(value) || value.length > max) fail(400, 'รายการข้อมูลไม่ถูกต้อง'); return value; }
export const success = data => ({ success: true, ...data });
export function json(value, fallback = []) { if (value === null || value === undefined || value === '') return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
export const fullName = row => `${row.prefix_name || ''}${row.first_name || ''} ${row.last_name || ''}`.trim();
