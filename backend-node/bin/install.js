import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { root,configFromEnv } from '../src/config.js';
import { migrate } from './migrate.js';
import { createDatabase,one,rows } from '../src/db.js';
import { text,integer,password as validatePassword,fail,HttpError } from '../src/validation.js';
import { hashPassword } from '../src/security.js';
import { hash } from '../src/security.js';
import { parseEnv } from 'node:util';
import { startApplication,attachShutdown } from '../src/runtime.js';
import { installerPage } from './install-page.js';

export async function bootstrap(input, destination = path.join(root,'.env'), paths = {}) {
  const lockPath=destination+'.install.lock';
  let lock;
  try { lock=await fs.open(lockPath,'wx',0o600); }
  catch(error){if(error.code==='EEXIST')fail(409,'มีการติดตั้งกำลังทำงานอยู่ ตรวจไฟล์ .env.install.lock หากเคยหยุดติดตั้งกลางทาง');throw error}
  try{return await installDatabase(input,destination,paths)}finally{await lock.close();await fs.unlink(lockPath).catch(()=>{})}
}
async function installDatabase(input, destination, paths) {
  if (await fs.stat(destination).catch(() => null)) fail(409,'มี .env อยู่แล้ว ระบบจะไม่เขียนทับ ใช้ npm start หรือขั้นตอนย้ายฐานเดิมใน README.md');
  const mode = input.mode;
  if (!['create','connect'].includes(mode)) fail(400,'เลือกสร้างใหม่หรือเชื่อมฐานเดิม');
  const name = text(input.db_name,'ชื่อฐาน',64), appUser = text(input.db_user,'บัญชีแอป',32);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || ['mysql','sys','information_schema','performance_schema'].includes(name.toLowerCase()) ||
    !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(appUser) || ['root','mysql','mysqladmin'].includes(appUser.toLowerCase())) fail(400,'ชื่อฐานหรือบัญชีแอปไม่ถูกต้อง');
  const appPass=validatePassword(input.db_password), adminPass=typeof input.admin_password==='string'?input.admin_password:'';
  if(/[\r\n\0]/.test(appPass))fail(400,'รหัสฐานข้อมูลต้องไม่มีอักขระขึ้นบรรทัดใหม่');
  const adminUser=text(input.admin_user,'ผู้ดูแล MySQL',128),port=integer(input.db_port,'พอร์ต',1,65535);
  const administratorPassword=validatePassword(input.app_admin_password);
  if(administratorPassword!==input.confirm_password)fail(400,'ยืนยันรหัสผู้ดูแลไม่ตรงกัน');
  const publicOrigin=new URL(text(input.public_origin,'URL เว็บไซต์',2048)).origin;
  if(!/^https?:$/.test(new URL(publicOrigin).protocol))fail(400,'URL ต้องเป็น HTTP หรือ HTTPS');
  const env={NODE_ENV:publicOrigin.startsWith('https:')?'production':'development',HOST:'127.0.0.1',PORT:'3000',PUBLIC_ORIGIN:publicOrigin,
    DB_HOST:'127.0.0.1',DB_PORT:String(port),DB_NAME:name,DB_USER:appUser,DB_PASS:appPass,
    SESSION_SIGNING_KEY:randomBytes(32).toString('base64'),MFA_ENCRYPTION_KEY:randomBytes(32).toString('base64'),TRUST_PROXY:'true',
    STORAGE_DIR:paths.storage||path.join(root,'storage'),LEGACY_DATA_DIR:paths.legacyData||process.env.LEGACY_DATA_DIR||path.resolve(root,'storage/legacy-import')};
  const config=configFromEnv(env);
  const privileged=await mysql.createConnection({host:'127.0.0.1',port,user:adminUser,password:adminPass,multipleStatements:true});
  let migrationPool;
  try {
    if(mode==='create'){
      const [existing]=await privileged.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[name]);
      const [account]=await privileged.execute("SELECT User FROM mysql.user WHERE User=? AND Host='localhost'",[appUser]);
      if(existing.length||account.length)fail(409,'ชื่อฐานหรือบัญชีนี้มีอยู่แล้ว เลือกเชื่อมฐานเดิมหรือใช้ชื่อใหม่');
      await privileged.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await privileged.query(`USE \`${name}\``);
      const schema=(await fs.readFile(path.join(root,'resources/schema.sql'),'utf8')).replace(/^DROP TABLE IF EXISTS [^;]+;\s*$/gm,'');
      await privileged.query(schema);
      await privileged.query("CREATE USER ?@'localhost' IDENTIFIED BY ?",[appUser,appPass]);
      await privileged.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${name}\`.* TO ?@'localhost'`,[appUser]);
    }else{
      await privileged.query(`USE \`${name}\``);
      let factors=[];
      try{[factors]=await privileged.query('SELECT user_id FROM node_mfa LIMIT 1')}catch(error){if(error.code!=='ER_NO_SUCH_TABLE')throw error}
      if(factors.length)fail(409,'ฐานนี้มี MFA ของ Node.js อยู่แล้ว ต้องกู้คืน .env และ MFA_ENCRYPTION_KEY ชุดเดิม ไม่สร้างกุญแจใหม่ทับ');
    }
    // The elevated account is used only during setup and is never written to .env.
    migrationPool=createDatabase({...config,db:{...config.db,user:adminUser,password:adminPass}});
    await migrate(migrationPool,config);
    const appDb=createDatabase(config);
    try {
      await one(appDb,'SELECT id FROM user LIMIT 1');
      const admin=await one(appDb,'SELECT id FROM user WHERE role=9 AND status=10 AND is_deleted=0 LIMIT 1');
      if(!admin){
        if(await one(appDb,"SELECT id FROM user WHERE username='admin' LIMIT 1"))fail(409,'มีชื่อ admin อยู่แล้ว ตรวจบัญชีเดิมก่อนตั้งผู้ดูแล');
        const id=randomUUID(),digest=await hashPassword(administratorPassword);
        const connection=await appDb.getConnection();
        try{await connection.beginTransaction();await rows(connection,'INSERT INTO user (id,username,password_hash,role,status,created_at) VALUES (?,\'admin\',?,9,10,NOW())',[id,digest]);await rows(connection,"INSERT INTO profile (user_id,first_name,last_name,srt) VALUES (?,'Administrator','Account',1)",[id]);await connection.commit();}
        catch(error){await connection.rollback();throw error}finally{connection.release()}
      }
    }finally{await appDb.end()}
    const saved={...env,DB_PASS_B64:Buffer.from(appPass,'utf8').toString('base64')};delete saved.DB_PASS;
    saved.STORAGE_DIR=saved.STORAGE_DIR.replaceAll('\\','/');saved.LEGACY_DATA_DIR=saved.LEGACY_DATA_DIR.replaceAll('\\','/');
    const contents=Object.entries(saved).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
    await fs.writeFile(destination,contents,{flag:'wx',mode:0o600});
    return {success:true,message:'ติดตั้งเสร็จแล้ว กดเปิดระบบเพื่อเข้าสู่หน้า Login แอดมินต้องตั้ง MFA ตอนเข้าสู่ระบบครั้งแรก'};
  } finally { await migrationPool?.end(); await privileged.end(); }
}

async function startConfiguredApplication() {
  const env={...process.env,...parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'))};
  await fs.access(path.join(configFromEnv(env).frontend,'index.html'));
  const runtime=await startApplication(env);attachShutdown(runtime);
  return {open_url:runtime.config.origin+'/vengg4/'};
}
export function createInstaller({ setup=bootstrap, existingFile=path.join(root,'.env'),start=startConfiguredApplication }={}) {
  const app=express(),token=randomBytes(32).toString('hex');let working=false,completed=false,starting=null;
  app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'none'"],scriptSrc:["'unsafe-inline'"],styleSrc:["'unsafe-inline'"],connectSrc:["'self'"],baseUri:["'none'"],formAction:["'self'"],frameAncestors:["'none'"]}}}));
  app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    const host=req.hostname;
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(host))return res.status(403).json({error:'เปิดตัวติดตั้งจาก localhost บนเครื่องเซิร์ฟเวอร์เท่านั้น'});
    next();
  });
  app.use(express.json({limit:'32kb'}));
  app.get('/setup-status',(req,res)=>res.json({application:'vengg4-web-setup',installation:hash(root.replaceAll('\\','/').toLowerCase())}));
  app.get('/',async(req,res)=>{
    const installed=completed||!!await fs.stat(existingFile).catch(()=>null);
    res.status(installed?410:200).type('html').send(installerPage(token,installed));
  });
  app.post('/start',async(req,res)=>{
    const supplied=req.get('X-Setup-Token')||'';
    if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return res.status(403).json({error:'Invalid setup token'});
    if(working)return res.status(409).json({error:'กรุณารอให้ติดตั้งเสร็จก่อน'});
    if(!completed&&!await fs.stat(existingFile).catch(()=>null))return res.status(409).json({error:'กรุณาติดตั้งให้เสร็จก่อนเปิดระบบ'});
    if(!starting)starting=Promise.resolve().then(()=>start()).catch(error=>{starting=null;throw error});
    try{res.json({success:true,...await starting})}catch(error){res.status(503).json({error:error.code==='EADDRINUSE'?'พอร์ตของระบบถูกใช้งานอยู่ หากระบบเปิดอยู่แล้ว ให้เข้าผ่าน URL เว็บไซต์ที่ตั้งไว้':error.code==='ENOENT'?'ไม่พบไฟล์ตั้งค่าหรือหน้าเว็บ ใช้ ZIP ตัวติดตั้งรุ่นที่ build แล้ว':'เปิดระบบไม่สำเร็จ ตรวจการเชื่อมต่อ MySQL และไฟล์ตั้งค่าของระบบ'});}
  });
  app.post('/setup',async(req,res)=>{
    const supplied=req.get('X-Setup-Token')||'';
    if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return res.status(403).json({error:'Invalid setup token'});
    if(completed)return res.status(410).json({error:'ติดตั้งแล้ว'});
    if(working)return res.status(409).json({error:'กำลังติดตั้งอยู่'});
    working=true;
    try{const result=await setup(req.body);completed=true;res.json(result)}
    catch(error){res.status(error instanceof HttpError?error.status:400).json({error:error instanceof HttpError?error.message:'ติดตั้งไม่สำเร็จ ตรวจ MySQL credentials/สิทธิ์ และฐานหรือบัญชีที่อาจสร้างค้างไว้ ห้ามลบฐานเดิม'});}
    finally{working=false}
  });
  app.use((error,req,res,next)=>res.status(400).json({error:'ข้อมูลติดตั้งไม่ถูกต้อง'}));
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=integer(process.env.SETUP_PORT||3001,'setup port',1,65535);
  createInstaller().listen(port,'127.0.0.1',()=>console.log(`Open http://localhost:${port} on this computer. Complete setup and start the application from your browser.`));
}
