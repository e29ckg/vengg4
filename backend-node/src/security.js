import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { one, rows } from './db.js';
import { fail } from './validation.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const hashPassword = value => bcrypt.hash(value, 12);
const dummyHash = '$2b$12$KbQi.2dP2k/ux8/6fOQZs.jhrEUznqt7tT2gKKVNs5R6ekQ3.3Mze';
export async function verifyPassword(value, digest) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 72 || value.includes('\0')) return false;
  return bcrypt.compare(value, (digest || dummyHash).replace(/^\$2y\$/, '$2b$'));
}
export function encryptSecret(value, key, userId) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  // Persisted format: retain this domain so Vengg3 Node ciphertext remains readable.
  cipher.setAAD(Buffer.from(`vengg3-mfa:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptSecret(value, key, userId) {
  const [version, iv, body, tag] = value.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('Invalid encrypted secret');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(`vengg3-mfa:${userId}`)); cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
}
export const newTotp = (secret, username = '') => new OTPAuth.TOTP({ issuer: 'Vengg4', label: username, algorithm: 'SHA1', digits: 6, period: 30,
  secret: secret ? OTPAuth.Secret.fromBase32(secret) : new OTPAuth.Secret({ size: 20 }) });
export function totpCounter(secret, code, now = Date.now(), lastCounter = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const delta = newTotp(secret).validate({ token: code, timestamp: now, window: 1 });
  const counter = delta === null ? null : Math.floor(now / 30000) + delta;
  return counter !== null && counter > Number(lastCounter) ? counter : null;
}
export const recoveryCodes = () => Array.from({ length: 10 }, () => randomBytes(10).toString('hex').match(/.{1,5}/g).join('-'));
export const recoveryHash = code => hash(code.toLowerCase().replace(/-/g, ''));
export async function limit(db, name, max, seconds = 900) {
  const bucket = hash(name);
  // The condition is evaluated before window_start changes. One atomic upsert across workers.
  await rows(db, `INSERT INTO node_rate_limits (bucket,window_start,attempts) VALUES (?,NOW(),1)
    ON DUPLICATE KEY UPDATE attempts=IF(window_start < DATE_SUB(NOW(),INTERVAL ? SECOND),1,attempts+1),
      window_start=IF(window_start < DATE_SUB(NOW(),INTERVAL ? SECOND),NOW(),window_start)`, [bucket, seconds, seconds]);
  const result = await one(db, 'SELECT attempts FROM node_rate_limits WHERE bucket=?', [bucket]);
  if (result.attempts > max) fail(429, 'ลองหลายครั้งเกินไป กรุณารอแล้วลองใหม่');
}
export function cookieNames(config) {
  const prefix = config.secure ? '__Host-' : '';
  return { session: `${prefix}vengg4_session`, challenge: `${prefix}vengg4_challenge`, csrf: `${prefix}vengg4_csrf` };
}
export const cookieOptions = config => ({ httpOnly: true, secure: config.secure, sameSite: 'strict', path: '/' });
export function cookies(req) {
  const result = Object.create(null);
  for (const entry of (req.headers.cookie || '').split(';')) {
    const index = entry.indexOf('='); if (index < 1) continue;
    const name = entry.slice(0, index).trim(); if (Object.hasOwn(result, name)) continue;
    try { result[name] = decodeURIComponent(entry.slice(index + 1).trim()); } catch { /* malformed cookie */ }
  }
  return result;
}
export const signCsrf = (value, key) => createHmac('sha256', key).update(`csrf:${value}`).digest('base64url');
export function issueCsrf(req, res, config) {
  const name = cookieNames(config).csrf;
  const existing = cookies(req)[name];
  const valid = value => { if (typeof value !== 'string') return false; const [nonce, signature] = value.split('.'); return /^[A-Za-z0-9_-]{43}$/.test(nonce || '') && equal(signature, signCsrf(nonce, config.sessionKey)); };
  const token = valid(existing) ? existing : (() => { const nonce = randomToken(); return `${nonce}.${signCsrf(nonce, config.sessionKey)}`; })();
  res.cookie(name, token, { ...cookieOptions(config), maxAge: 8 * 3600000 });
  return { csrf_token: token };
}
export function enforceCsrf(req, config) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const token = req.get('x-csrf-token'), stored = cookies(req)[cookieNames(config).csrf];
  if (!equal(token, stored)) fail(403, 'Invalid CSRF token', 'CSRF');
  const [nonce, signature] = token.split('.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce || '') || !equal(signature, signCsrf(nonce, config.sessionKey))) fail(403, 'Invalid CSRF token', 'CSRF');
}
export async function authenticate(db, req, config) {
  const token = cookies(req)[cookieNames(config).session];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'กรุณาเข้าสู่ระบบใหม่', 'AUTH_REQUIRED');
  const user = await one(db, `SELECT u.id,u.username,u.role,u.password_hash,s.token_hash,s.password_stamp,s.mfa_verified,
    m.user_id AS has_mfa,r.user_id AS needs_enrollment FROM node_sessions s JOIN user u ON u.id=s.user_id LEFT JOIN node_mfa m ON m.user_id=u.id
    LEFT JOIN node_mfa_resets r ON r.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>NOW() AND u.status=10 AND u.is_deleted=0`, [hash(token)]);
  if (!user || user.needs_enrollment || user.password_stamp !== hash(user.password_hash) || (Number(user.role) === 9 && !user.has_mfa) || (user.has_mfa && !user.mfa_verified)) fail(401, 'Session หมดอายุหรือยังไม่ผ่าน MFA', 'AUTH_REQUIRED');
  const settings = await one(db, 'SELECT maintenance_mode FROM system_settings WHERE id=1');
  if (settings?.maintenance_mode && Number(user.role) !== 9) fail(403, 'ระบบกำลังปิดปรับปรุง', 'MAINTENANCE');
  return user;
}
