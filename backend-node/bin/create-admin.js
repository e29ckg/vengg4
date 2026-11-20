import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../src/config.js';
import { createDatabase, rows, one, transaction } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { password, text } from '../src/validation.js';

const config = configFromEnv(), db = createDatabase(config);
try {
  if(process.argv.includes('--check')) {
    const existing=await one(db,'SELECT id FROM user WHERE role=9 AND is_deleted=0 LIMIT 1');
    process.exitCode=existing?0:3;
  } else {
  if(process.argv.includes('--password-stdin')) {
    const chunks=[];let length=0;
    for await(const chunk of process.stdin){length+=chunk.length;if(length>256)throw Error('Password input too long');chunks.push(chunk)}
    process.env.ADMIN_PASSWORD=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
  }
  const username = text(process.env.ADMIN_USERNAME || 'admin','username',128);
  const digest = await hashPassword(password(process.env.ADMIN_PASSWORD));
  await transaction(db, async connection => {
    const lock = await one(connection, "SELECT GET_LOCK('vengg4-create-admin',10) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error('Administrator creation is already running');
    try {
      if (await one(connection, 'SELECT id FROM user WHERE role=9 AND is_deleted=0 LIMIT 1')) throw new Error('Administrator exists; it will not be reset');
      const id = randomUUID();
      await rows(connection, 'INSERT INTO user (id,username,password_hash,role,status,created_at) VALUES (?,?,?,9,10,NOW())', [id,username,digest]);
      await rows(connection, "INSERT INTO profile (user_id,first_name,last_name,srt) VALUES (?,'Administrator','Account',1)", [id]);
    } finally { await connection.query("SELECT RELEASE_LOCK('vengg4-create-admin')"); }
  });
  console.log('Administrator created. MFA enrollment is required on first login.');
  }
} finally { delete process.env.ADMIN_PASSWORD; await db.end(); }
