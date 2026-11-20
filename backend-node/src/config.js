import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function configFromEnv(env = process.env) {
  const key = name => {
    const value = Buffer.from(env[name] || '', 'base64');
    if (value.length !== 32 || value.toString('base64') !== env[name]) throw new Error(`${name} must be a random 32-byte base64 key`);
    return value;
  };
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:5173').origin;
  const production = env.NODE_ENV === 'production';
  const secure = production || env.COOKIE_SECURE === 'true';
  if (production && !origin.startsWith('https://')) throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  const sessionKey = key('SESSION_SIGNING_KEY'), mfaKey = key('MFA_ENCRYPTION_KEY');
  if (sessionKey.equals(mfaKey)) throw new Error('Session and MFA keys must be different');
  const dbPassword=env.DB_PASS_B64?Buffer.from(env.DB_PASS_B64,'base64').toString('utf8'):env.DB_PASS;
  if(env.DB_PASS_B64&&Buffer.from(env.DB_PASS_B64,'base64').toString('base64')!==env.DB_PASS_B64)throw new Error('DB_PASS_B64 must contain canonical base64');
  if (!env.DB_USER || !dbPassword || !/^[a-zA-Z0-9_]{1,64}$/.test(env.DB_NAME || '')) throw new Error('Set DB_USER, DB_PASS and DB_NAME');
  const trustedProxies=(env.TRUST_PROXY_CIDRS||'loopback').split(',').map(value=>value.trim()).filter(Boolean);
  if(trustedProxies.length>32||trustedProxies.some(value=>['0.0.0.0/0','::/0','true'].includes(value)))throw new Error('Trust only explicit reverse-proxy addresses, never all clients');
  return {
    production, secure, sessionKey, mfaKey, origin,
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3000), trustProxy: env.TRUST_PROXY === 'true',trustedProxies,
    allowedOrigins: new Set([origin, ...(env.CORS_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]),
    db: { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), database: env.DB_NAME,
      user: env.DB_USER, password: dbPassword, charset: 'utf8mb4', timezone: '+07:00', dateStrings: true,
      connectionLimit: 10, multipleStatements: false, namedPlaceholders: false, supportBigNumbers: true },
    storage: path.resolve(root, env.STORAGE_DIR || 'storage'),
    legacyData: path.resolve(root, env.LEGACY_DATA_DIR || 'storage/legacy-import'),
    frontend: path.resolve(root, env.FRONTEND_DIR || '../frontend/dist'),
  };
}
