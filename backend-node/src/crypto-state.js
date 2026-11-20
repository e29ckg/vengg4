import fs from 'node:fs/promises';
import path from 'node:path';
import { one } from './db.js';
import { decryptSecret } from './security.js';

export async function verifyEncryptionKey(db,config) {
  const mfa=await one(db,'SELECT user_id,secret_encrypted FROM node_mfa LIMIT 1');
  const telegram=await one(db,'SELECT bot_token FROM telegram_settings WHERE id=1');
  const google=await fs.readFile(path.join(config.storage,'google-credentials.enc'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error});
  try {
    if(mfa)decryptSecret(mfa.secret_encrypted,config.mfaKey,mfa.user_id);
    if(telegram?.bot_token?.startsWith('v1.'))decryptSecret(telegram.bot_token,config.mfaKey,'telegram');
    if(google)decryptSecret(google,config.mfaKey,'google');
  } catch { throw new Error('MFA_ENCRYPTION_KEY does not match stored encrypted data. Restore the original key before starting or migrating.'); }
}
