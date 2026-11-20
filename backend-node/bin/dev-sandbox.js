// Local development only. Starts a separate database data directory and never
// reads the production .env or registers a Windows service.
import fs from 'node:fs/promises';
import { openSync,closeSync,appendFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { root,configFromEnv } from '../src/config.js';
import { createDatabase,one,rows,transaction } from '../src/db.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../src/security.js';

const directory=path.join(root,'storage/dev-sandbox');
await fs.mkdir(directory,{recursive:true,mode:0o700});
const logFile=path.join(directory,'supervisor.log');
const log=message=>appendFileSync(logFile,`${new Date().toISOString()} ${message}\n`);
async function freePort(preferred=0){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(preferred,'127.0.0.1',resolve)});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function launch(executable,args,cwd,env=process.env,name='child'){
  const fd=openSync(path.join(directory,`${name}.log`),'a',0o600);
  try{return spawn(executable,args,{cwd,env,stdio:['ignore',fd,fd],windowsHide:true})}finally{closeSync(fd)}
}
const processes=[];let settings;
try{
  await freePort(3000);await freePort(5173);
  const privateFile=path.join(directory,'private.json');
  settings=JSON.parse(await fs.readFile(privateFile,'utf8').catch(error=>{if(error.code==='ENOENT')return 'null';throw error}));
  const binary=process.env.DEV_MYSQLD;
  if(!binary)throw Error('Set DEV_MYSQLD to the MariaDB mysqld.exe path; mysql_install_db.exe must be beside it');
  const data=path.join(directory,'mysql');
  if(!settings){
    settings={port:await freePort(),rootPassword:randomBytes(24).toString('hex'),appPassword:randomBytes(24).toString('hex'),adminPassword:`Dev-${randomBytes(12).toString('base64url')}`,
      sessionKey:randomBytes(32).toString('base64'),mfaKey:randomBytes(32).toString('base64')};
    await fs.writeFile(privateFile,JSON.stringify(settings),{flag:'wx',mode:0o600});
    await promisify(execFile)(path.join(path.dirname(binary),'mysql_install_db.exe'),[`--datadir=${data}`,`--password=${settings.rootPassword}`,`--port=${settings.port}`],{timeout:120000,windowsHide:true});
  }
  const database=launch(binary,[`--defaults-file=${path.join(data,'my.ini')}`,`--datadir=${data}`,`--port=${settings.port}`,'--bind-address=127.0.0.1','--skip-log-bin','--console',`--pid-file=${path.join(directory,'mysql.pid')}`],directory,process.env,'database');
  processes.push(database);
  const connectionOptions={host:'127.0.0.1',port:settings.port,user:'root',password:settings.rootPassword};
  let admin;
  for(let attempt=0;attempt<120;attempt++){
    try{admin=await mysql.createConnection({...connectionOptions,multipleStatements:true});break}catch{if(database.exitCode!==null)throw Error('Development database exited');await new Promise(resolve=>setTimeout(resolve,500))}
  }
  if(!admin)throw Error('Development database did not become ready');
  const env={NODE_ENV:'development',HOST:'127.0.0.1',PORT:'3000',PUBLIC_ORIGIN:'http://localhost:5173',CORS_ALLOWED_ORIGINS:'http://localhost:5173,http://127.0.0.1:5173',
    DB_HOST:'127.0.0.1',DB_PORT:String(settings.port),DB_NAME:'vengg4_dev',DB_USER:'vengg_dev',DB_PASS:settings.appPassword,
    SESSION_SIGNING_KEY:settings.sessionKey,MFA_ENCRYPTION_KEY:settings.mfaKey,STORAGE_DIR:path.join(directory,'app'),LEGACY_DATA_DIR:path.join(directory,'no-legacy'),TRUST_PROXY:'false',COOKIE_SECURE:'false'};
  const config=configFromEnv(env);
  try{
    const [exists]=await admin.execute("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='vengg4_dev'");
    if(!exists.length){
      await admin.query('CREATE DATABASE vengg4_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await admin.query('USE vengg4_dev');
      await admin.query((await fs.readFile(path.join(root,'resources/schema.sql'),'utf8')).replace(/^DROP TABLE IF EXISTS [^;]+;\s*$/gm,''));
      await admin.query("CREATE USER 'vengg_dev'@'localhost' IDENTIFIED BY ?",[settings.appPassword]);
      await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON vengg4_dev.* TO 'vengg_dev'@'localhost'");
    }
    const migrationDb=createDatabase({...config,db:{...config.db,user:'root',password:settings.rootPassword}});
    try{await migrate(migrationDb,config)}finally{await migrationDb.end()}
    const db=createDatabase(config);
    try{
      if(!await one(db,"SELECT id FROM user WHERE username='admin'")){
        const digest=await hashPassword(settings.adminPassword);
        await transaction(db,async connection=>{
          await rows(connection,"INSERT INTO user (id,username,password_hash,role,status,created_at) VALUES ('dev-admin','admin',?,9,10,NOW())",[digest]);
          await rows(connection,"INSERT INTO profile (user_id,first_name,last_name,srt) VALUES ('dev-admin','Dev','Administrator',1)");
        });
      }
    }finally{await db.end()}
  }finally{await admin.end()}
  const safeEnv={...env,DB_PASS_B64:Buffer.from(settings.appPassword).toString('base64')};delete safeEnv.DB_PASS;
  await fs.writeFile(path.join(root,'.env.dev-sandbox'),Object.entries(safeEnv).map(([key,value])=>`${key}=${JSON.stringify(value.replaceAll('\\','/'))}`).join('\n')+'\n',{mode:0o600});
  const backend=launch(process.execPath,['--watch','src/server.js'],root,{...process.env,...env},'backend');
  processes.push(backend);
  const frontendRoot=path.resolve(root,'../frontend');
  const frontend=launch(process.execPath,[path.join(frontendRoot,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5173','--strictPort'],frontendRoot,
    {...process.env,NODE_ENV:'development',VITE_API_BASE_URL:'/api/'},'frontend');
  processes.push(frontend);
  for(let attempt=0;attempt<60;attempt++){
    try{
      const api=await fetch('http://127.0.0.1:3000/api/?route=test',{signal:AbortSignal.timeout(2000)});
      const page=await fetch('http://127.0.0.1:5173/',{signal:AbortSignal.timeout(2000)});
      if(api.ok&&page.ok){
        await fs.writeFile(path.join(directory,'status.json'),JSON.stringify({ready:true,pid:process.pid,databasePid:database.pid,backendPid:backend.pid,frontendPid:frontend.pid,databasePort:settings.port,frontend:'http://localhost:5173',backend:'http://127.0.0.1:3000',username:'admin'}));
        log('Development servers ready');break;
      }
    }catch{}
    if(attempt===59)throw Error('Development servers did not become ready');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  for(const child of processes){child.on('error',()=>log('Child process error'));child.on('exit',code=>log(`Child exited with code ${code}`));}
}catch(error){
  log(`Startup failed: ${error.code||error.message}`);
  await fs.writeFile(path.join(directory,'status.json'),JSON.stringify({ready:false,error:'Development startup failed. See supervisor/database/backend/frontend logs.'}));
  for(const child of processes)if(child.exitCode===null)child.kill();
  process.exitCode=1;
}
