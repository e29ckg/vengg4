import { configFromEnv } from '../src/config.js';
import { createDatabase, one, rows, transaction, audit } from '../src/db.js';

const username = process.argv[2];
if (!username || process.argv[3] !== '--confirm-identity-verified') throw new Error('Usage: node --env-file=.env bin/reset-mfa.js USERNAME --confirm-identity-verified');
const config = configFromEnv(), db = createDatabase(config);
try {
  await transaction(db,async connection => {
    const user = await one(connection, 'SELECT id FROM user WHERE username=? AND is_deleted=0 FOR UPDATE', [username]);
    if (!user) throw new Error('User not found');
    for (const table of ['node_mfa','node_mfa_recovery','node_sessions','node_challenges']) await rows(connection, `DELETE FROM ${table} WHERE user_id=?`, [user.id]);
    await rows(connection, 'INSERT INTO node_mfa_resets (user_id,requested_by) VALUES (?,?) ON DUPLICATE KEY UPDATE requested_by=VALUES(requested_by),created_at=NOW()', [user.id, 'CLI']);
    await rows(connection, 'UPDATE user SET auth_key=NULL WHERE id=?', [user.id]);
    await audit(connection,user,'MFA_RESET','AUTH','Offline recovery after identity verification','CLI');
  });
  console.log('MFA reset and sessions revoked. User must enroll again at next login.');
} finally { await db.end(); }
