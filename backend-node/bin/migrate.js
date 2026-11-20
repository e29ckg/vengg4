import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configFromEnv, root } from '../src/config.js';
import { createDatabase, rows, one } from '../src/db.js';
import { hash } from '../src/security.js';
import { atomicWrite, validateCredentials } from '../src/integrations.js';
import { encryptSecret,decryptSecret } from '../src/security.js';
import { verifyEncryptionKey } from '../src/crypto-state.js';

export async function migrate(db, config) {
  const connection = await db.getConnection();
  try {
    const lock = await one(connection, "SELECT GET_LOCK('vengg4-node-migrations',30) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error('Another migration is running');
    // No DROP, ALTER, live schema import or replacement of existing business tables.
    await rows(connection, 'SELECT id,username,password_hash,role,status,is_deleted FROM user LIMIT 0');
    const directory = path.join(root,'migrations');
    for (const file of (await fs.readdir(directory)).filter(name => /^\d+[-a-z0-9]+\.sql$/.test(name)).sort()) {
      const sql = (await fs.readFile(path.join(directory,file),'utf8')).replaceAll('\r\n','\n');
      await rows(connection, 'CREATE TABLE IF NOT EXISTS node_schema_migrations (name VARCHAR(128) PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
      const previous = await one(connection, 'SELECT checksum FROM node_schema_migrations WHERE name=?', [file]);
      if (previous) { if (previous.checksum !== hash(sql)) throw new Error(`Applied migration has changed: ${file}`); continue; }
      for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await rows(connection, 'INSERT INTO node_schema_migrations (name,checksum) VALUES (?,?)', [file,hash(sql)]);
    }
    await verifyEncryptionKey(connection,config);
    await rows(connection, 'UPDATE user SET auth_key=NULL WHERE auth_key IS NOT NULL');
  } finally {
    await connection.query("SELECT RELEASE_LOCK('vengg4-node-migrations')").catch(() => {});
    connection.release();
  }
  // Copy existing user artifacts; never remove or overwrite originals or newer Node files.
  const importMarker=path.join(config.storage,'.legacy-imported.json');
  let imported;
  try{imported=JSON.parse(await fs.readFile(importMarker,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  if(imported?.source===hash(config.legacyData))return;
  const optional=async task=>{try{return await task()}catch(error){if(error.code==='ENOENT')return null;throw new Error('Cannot read legacy artifacts. Run migration with permission to read the legacy folders; do not skip user files.')}};
  for (const [from,to] of [['public/uploads/avatars','avatars'],['storage/document-templates','document-templates']]) {
    const source = path.join(config.legacyData,from), destination = path.join(config.storage,to);
    await fs.mkdir(destination,{ recursive: true,mode: 0o750 });
    for (const entry of await optional(()=>fs.readdir(source,{ withFileTypes: true })) || []) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp|docx)$/i.test(entry.name)) continue;
      await fs.copyFile(path.join(source,entry.name),path.join(destination,entry.name),fs.constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
  }
  const destination = path.join(config.storage,'google-credentials.enc');
  const sealed=await fs.readFile(destination,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error});
  if(sealed){try{decryptSecret(sealed,config.mfaKey,'google')}catch{throw new Error('Stored Google credentials use a different encryption key. Restore the original key before migration.')}}
  const old = await optional(()=>fs.readFile(path.join(config.legacyData,'src/Config/credentials.json')));
  if (old && !await fs.stat(destination).catch(() => null)) {
    await atomicWrite(destination,encryptSecret(JSON.stringify(validateCredentials(old)),config.mfaKey,'google'));
  }
  await atomicWrite(importMarker,JSON.stringify({source:hash(config.legacyData),completed_at:new Date().toISOString()}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = configFromEnv(), db = createDatabase(config);
  try { await migrate(db,config); console.log('Node security migrations applied. Business data preserved; legacy sessions invalidated.'); }
  finally { await db.end(); }
}
