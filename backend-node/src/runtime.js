import fs from 'node:fs/promises';
import { configFromEnv } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { verifyEncryptionKey } from './crypto-state.js';

export async function startApplication(env = process.env) {
  const config=configFromEnv(env),db=createDatabase(config);
  try {
    const [migrations]=await db.execute("SELECT name FROM node_schema_migrations WHERE name IN ('001-node-security.sql','002-mfa-reset.sql')");
    if(migrations.length!==2)throw new Error('Run security migrations (including MFA reset) before starting Node.js');
    await verifyEncryptionKey(db,config);
    await fs.mkdir(config.storage,{recursive:true,mode:0o750});
    const app=createApp({db,config});
    const server=await new Promise((resolve,reject)=>{
      const listener=app.listen(config.port,config.host,()=>resolve(listener));
      listener.once('error',reject);
    });
    server.requestTimeout=30000;server.headersTimeout=15000;
    return {server,db,config};
  } catch(error) { await db.end();throw error; }
}
export function attachShutdown({server,db}) {
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
    if(stopping)return;stopping=true;
    const timer=setTimeout(()=>process.exit(1),15000);timer.unref();
    server.close(async()=>{await db.end();clearTimeout(timer);process.exit(0)});
  });
}
