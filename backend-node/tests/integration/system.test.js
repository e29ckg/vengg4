import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createApp } from '../../src/app.js';
import { configFromEnv,root } from '../../src/config.js';
import { createDatabase,rows,one } from '../../src/db.js';
import { migrate } from '../../bin/migrate.js';
import { hashPassword,newTotp } from '../../src/security.js';
import { bootstrap } from '../../bin/install.js';
import { Integrations } from '../../src/integrations.js';
import { parseEnv } from 'node:util';
import { verifyEncryptionKey } from '../../src/crypto-state.js';
import { startApplication } from '../../src/runtime.js';

test('native Node backend with isolated MySQL: API contracts and security', { skip: !process.env.TEST_DB_HOST },async t => {
  const databaseName = `vengg4_node_test_${randomBytes(5).toString('hex')}`;
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(),'vengg4-integration-'));
  const connectionOptions = { host:process.env.TEST_DB_HOST,port:Number(process.env.TEST_DB_PORT || 3306),user:process.env.TEST_DB_USER,password:process.env.TEST_DB_PASS };
  const admin = await mysql.createConnection({ ...connectionOptions,multipleStatements:true });
  await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`USE \`${databaseName}\``);
  await admin.query(await fs.readFile(path.join(root,'resources/schema.sql'),'utf8'));
  const config = configFromEnv({ NODE_ENV:'test',DB_HOST:connectionOptions.host,DB_PORT:String(connectionOptions.port),DB_USER:connectionOptions.user,DB_PASS:connectionOptions.password,DB_NAME:databaseName,
    SESSION_SIGNING_KEY:randomBytes(32).toString('base64'),MFA_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_ORIGIN:'http://localhost:5173',STORAGE_DIR:path.join(fixture,'storage'),LEGACY_DATA_DIR:path.join(fixture,'legacy'),FRONTEND_DIR:path.join(fixture,'frontend') });
  const db = createDatabase(config);
  await fs.mkdir(path.join(config.frontend,'assets'),{recursive:true});
  await fs.writeFile(path.join(config.frontend,'index.html'),'<html><script src="/assets/main.js"></script></html>');
  await fs.writeFile(path.join(config.frontend,'assets/main.js'),'console.log("fixture")');
  await migrate(db,config);
  const digest = await hashPassword('Fixture-password-123');
  for (const [id,role] of [['admin',9],['director',2],['finance',3],['alice',1],['bob',1],['charlie',1]]) {
    await rows(db,'INSERT INTO user (id,username,password_hash,role,status) VALUES (?,?,?,?,10)',[id,id,digest.replace(/^\$2b\$/,'$2y$'),role]);
    await rows(db,'INSERT INTO profile (user_id,first_name,last_name,position,phone,bank_account) VALUES (?,?,\'Fixture\',\'Staff\',\'private-phone\',\'private-bank\')',[id,id]);
  }
  await rows(db,"INSERT INTO ven_name (id,name,name_full,dn,srt,status) VALUES (1,'Day','Day duty','กลางวัน(08.30-16.30)',1,1)");
  await rows(db,"INSERT INTO ven_name_sub (id,name,ven_name_id,price,color,srt,status) VALUES (1,'Main desk',1,200,'#0066cc',1,1)");
  await rows(db,"INSERT INTO ven_com (id,com_num,com_date,ven_month,status,ven_name_id,ven_com_days) VALUES (1,'1/2090','2090-01-01','2090-01','1',1,'20,21,22')");
  for (const id of ['alice','bob']) await rows(db,'INSERT INTO ven_user (user_id,ven_name_sub_id,srt) VALUES (?,1,1)',[id]);
  await rows(db,"INSERT INTO ven_schedule (id,ven_date,ven_com_id,ven_name_sub_id,user_id,status) VALUES (1,'2090-01-20',1,1,'alice',1),(2,'2090-01-21',1,1,'bob',1)");
  const integrations = {sendTelegram:async()=>false,afterTransfer:async()=>{},syncGoogle:async()=>({success:true})};
  const app = createApp({db,config,integrations});
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  class Browser {
    cookies = new Map(); csrf='';
    async request(route,method='GET',body,extraHeaders={}) {
      if (method !== 'GET' && !this.csrf) this.csrf=(await this.request('auth/csrf')).data.csrf_token;
      const form=body instanceof FormData;
      const headers={ ...(method !== 'GET'?{'X-CSRF-Token':this.csrf}:{}),...(body!==undefined&&!form?{'Content-Type':'application/json'}:{}),Cookie:[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; '),...extraHeaders };
      const response=await fetch(`${base}/api/?route=${route}`,{method,headers,body:body===undefined?undefined:form?body:JSON.stringify(body)});
      for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],index=pair.indexOf('=');if(pair.slice(index+1))this.cookies.set(pair.slice(0,index),pair.slice(index+1));else this.cookies.delete(pair.slice(0,index));}
      const content=await response.text();let data;try{data=JSON.parse(content)}catch{data=content}
      return {status:response.status,data,headers:response.headers};
    }
    login(username){return this.request('auth/login','POST',{username,password:'Fixture-password-123'})}
  }
  const guest=new Browser(),owner=new Browser(),receiver=new Browser(),director=new Browser(),finance=new Browser(),administrator=new Browser();
  let adminSecret,adminCodes,changeId;
  const bootstrapDb=`vengg4_node_test_${randomBytes(5).toString('hex')}`,bootstrapUser=`vengg4_test_${randomBytes(4).toString('hex')}`;
  try {
    await t.test('migration is additive and idempotent',async()=>{
      await migrate(db,config); assert.equal((await one(db,'SELECT COUNT(*) AS n FROM user')).n,6);assert.equal((await one(db,'SELECT COUNT(*) AS n FROM ven_schedule')).n,2);
      const previous=await one(db,"SELECT checksum FROM node_schema_migrations WHERE name='001-node-security.sql'");
      await rows(db,"UPDATE node_schema_migrations SET checksum=? WHERE name='001-node-security.sql'",['0'.repeat(64)]);
      try{await assert.rejects(migrate(db,config),/migration has changed/)}finally{await rows(db,"UPDATE node_schema_migrations SET checksum=? WHERE name='001-node-security.sql'",[previous.checksum])}
    });
    await t.test('Node web bootstrap creates a fresh database with CRUD-only app privileges',async()=>{
      const envFile=path.join(fixture,'bootstrap.env');
      const input={mode:'create',db_name:bootstrapDb,db_user:bootstrapUser,db_password:'Bootstrap-app-\"\'#=$123',db_port:String(connectionOptions.port),admin_user:connectionOptions.user,
        admin_password:connectionOptions.password,app_admin_password:'Bootstrap-admin-password-123',confirm_password:'Bootstrap-admin-password-123',public_origin:'http://localhost:3000'};
      await bootstrap(input,envFile,{storage:path.join(fixture,'bootstrap-storage'),legacyData:path.join(fixture,'no-legacy')});
      const contents=await fs.readFile(envFile,'utf8');assert.ok(!contents.includes(connectionOptions.password));assert.ok(contents.includes('MFA_ENCRYPTION_KEY='));
      assert.equal(configFromEnv(parseEnv(contents)).db.password,input.db_password);
      const running=await startApplication({...parseEnv(contents),PORT:'0',FRONTEND_DIR:config.frontend});
      try{
        const started=`http://127.0.0.1:${running.server.address().port}`;
        assert.equal((await fetch(`${started}/healthz`)).status,200);
        assert.equal((await fetch(`${started}/vengg4/api/?route=test`)).status,200);
      }finally{await new Promise(resolve=>running.server.close(resolve));await running.db.end()}
      const appDb=await mysql.createConnection({...connectionOptions,user:bootstrapUser,password:input.db_password,database:bootstrapDb});
      try{assert.equal((await appDb.execute('SELECT role FROM user WHERE username=\'admin\''))[0][0].role,9);await assert.rejects(appDb.query('CREATE TABLE should_be_denied (id INT)'));}
      finally{await appDb.end()}
      await assert.rejects(bootstrap(input,envFile),/มี .env/);
    });
    await t.test('legacy user artifacts are copied without replacing newer Node files',async()=>{
      const legacy=path.join(config.legacyData,'public/uploads/avatars');await fs.mkdir(legacy,{recursive:true});
      await fs.writeFile(path.join(legacy,'fixture.webp'),'legacy-image');
      await fs.unlink(path.join(config.storage,'.legacy-imported.json'));
      await migrate(db,config);assert.equal(await fs.readFile(path.join(config.storage,'avatars/fixture.webp'),'utf8'),'legacy-image');
      await fs.writeFile(path.join(config.storage,'avatars/fixture.webp'),'newer-image');
      await migrate(db,config);assert.equal(await fs.readFile(path.join(config.storage,'avatars/fixture.webp'),'utf8'),'newer-image');
    });
    await t.test('method, CSRF, Origin, body limit and legacy bearer bypass are blocked',async()=>{
      assert.equal((await guest.request('admin/user/list')).status,401);
      assert.equal((await guest.request('admin/user/list','GET',undefined,{Authorization:'Bearer v1.forged'})).status,401);
      assert.equal((await guest.request('auth/login')).status,405);
      assert.equal((await guest.request('auth/login','POST',{username:'alice',password:'Fixture-password-123'},{'X-CSRF-Token':'forged'})).status,403);
      assert.equal((await guest.request('test','GET',undefined,{Origin:'https://evil.invalid'})).status,403);
      assert.equal((await guest.request('auth/login','POST',{username:'x'.repeat(1100000),password:'x'})).status,413);
      assert.equal((await fetch(`${base}/backend-node/.env`)).status,404);
    });
    await t.test('production requires HTTPS and uses host-scoped Secure HttpOnly cookies',async()=>{
      const secureApp=createApp({db,config:{...config,production:true,secure:true,trustProxy:true,trustedProxies:['loopback']},integrations});
      const secureServer=secureApp.listen(0,'127.0.0.1');await new Promise(resolve=>secureServer.once('listening',resolve));
      const url=`http://127.0.0.1:${secureServer.address().port}`;
      try{
        assert.equal((await fetch(`${url}/api/?route=test`)).status,400);
        assert.equal((await fetch(`${url}/healthz`)).status,200);
        const response=await fetch(`${url}/api/?route=auth/csrf`,{headers:{'X-Forwarded-Proto':'https'}});
        assert.equal(response.status,200);const cookie=response.headers.getSetCookie().join(';');
        assert.match(cookie,/__Host-vengg4_csrf=/);assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
      }finally{await new Promise(resolve=>secureServer.close(resolve))}
    });
    await t.test('administrators cannot access APIs before MFA enrollment completes',async()=>{
      const login=await administrator.login('admin');assert.equal(login.status,200);assert.equal(login.data.enrollment_required,true);assert.equal(login.data.authenticated,undefined);
      assert.equal(administrator.cookies.has('vengg4_session'),false);assert.equal((await administrator.request('admin/user/list')).status,401);
      adminSecret=login.data.secret;
      const confirmed=await administrator.request('auth/mfa/confirm','POST',{code:newTotp(adminSecret).generate()});
      assert.equal(confirmed.status,200);assert.equal(confirmed.data.authenticated,true);adminCodes=confirmed.data.recovery_codes;assert.equal(adminCodes.length,10);
      assert.match(confirmed.headers.getSetCookie().join(';'),/HttpOnly/);assert.match(confirmed.headers.getSetCookie().join(';'),/SameSite=Strict/);
      const stored=await one(db,'SELECT secret_encrypted FROM node_mfa WHERE user_id=\'admin\'');assert.ok(!stored.secret_encrypted.includes(adminSecret));
      assert.equal((await administrator.request('admin/user/list')).status,200);
      assert.equal((await administrator.request('auth/mfa/disable','POST',{password:'Fixture-password-123',code:adminCodes[0]})).status,403);
    });
    await t.test('migration/startup reject a wrong MFA key and reinstall cannot silently replace keys',async()=>{
      await verifyEncryptionKey(db,config);
      await assert.rejects(verifyEncryptionKey(db,{...config,mfaKey:randomBytes(32)}),/original key/);
      await assert.rejects(migrate(db,{...config,mfaKey:randomBytes(32)}),/original key/);
      const envFile=path.join(fixture,'reinstall.env');
      await assert.rejects(bootstrap({mode:'connect',db_name:databaseName,db_user:bootstrapUser,db_password:'App-password-123',db_port:String(connectionOptions.port),admin_user:connectionOptions.user,
        admin_password:connectionOptions.password,app_admin_password:'Admin-password-123',confirm_password:'Admin-password-123',public_origin:'http://localhost:3000'},envFile,{storage:path.join(fixture,'reinstall-storage'),legacyData:path.join(fixture,'none')}),/MFA_ENCRYPTION_KEY/);
      await assert.rejects(fs.stat(envFile));
    });
    await t.test('ordinary users may log in without MFA, RBAC protects private directories',async()=>{
      for(const [client,name] of [[owner,'alice'],[receiver,'bob'],[director,'director'],[finance,'finance']])assert.equal((await client.login(name)).data.authenticated,true);
      assert.equal((await owner.request('admin/user/list')).status,403);assert.equal((await owner.request('users/list')).status,403);
      const directory=await director.request('users/list');assert.equal(directory.status,200);assert.equal(JSON.stringify(directory.data).includes('private-bank'),false);
      assert.equal((await director.request('admin/ven_com/list')).status,200);assert.equal((await director.request('finance/report&month=2090-01&command_id=1')).status,403);
      assert.equal((await finance.request('finance/report&month=2090-01&command_id=1')).data.data.report_list.length,2);
    });
    await t.test('calendar, settings and report contracts work natively',async()=>{
      const calendar=await owner.request('ven/list&month=2090-01');assert.equal(calendar.data.length,2);assert.equal(calendar.data[0].title,'alice Fixture');assert.equal(calendar.data[0].ven_time,'08:30');
      assert.equal((await owner.request('ven/detail&id=1')).data.ven_id,1);
      assert.equal((await owner.request('report/monthly&month=1&year=2090')).data.length,1);
      assert.equal((await owner.request('report/schedule-details&command_id=1')).data[0].staff_list[0].full_name,'alice Fixture');
      assert.equal((await director.request('admin/ven_schedule/ven_name_list')).data.data[0].subs.length,1);
      assert.ok(Array.isArray((await director.request('admin/ven_time')).data));
      assert.equal((await owner.request('ven/list&month=not-a-month')).status,400);
      assert.equal((await owner.request('ven/detail&id=1%20OR%201=1')).status,400);
    });
    await t.test('settings/options input allowlists prevent mass assignment',async()=>{
      assert.equal((await director.request('admin/ven_schedule/move','POST',{id:1,date:'2090-02-01'})).status,400);
      assert.equal((await one(db,'SELECT ven_date FROM ven_schedule WHERE id=1')).ven_date,'2090-01-20');
      assert.equal((await director.request('admin/ven_schedule/move','POST',{id:1,date:'2090-01-19'})).status,200);
      assert.equal((await one(db,'SELECT ven_date FROM ven_schedule WHERE id=1')).ven_date,'2090-01-19');
      assert.equal((await director.request('admin/ven_schedule/move','POST',{id:1,date:'2090-01-20'})).status,200);
      assert.equal((await one(db,'SELECT COUNT(*) AS n FROM ven_schedule')).n,2);
      assert.equal((await administrator.request('admin/options/add','POST',{type:'prefix',value:'Dr.'})).status,200);
      assert.equal((await administrator.request('admin/options/add','POST',{type:'__proto__',value:'bad'})).status,400);
      assert.ok((await owner.request('admin/options/get')).data.prefixes.includes('Dr.'));
      assert.equal((await administrator.request('admin/settings/update_toggle','POST',{setting_key:'password_hash',setting_value:'oops'})).status,400);
      assert.equal((await owner.request('user/profile/update','POST',{first_name:'Alice',role:9,user_id:'admin'})).status,200);
      assert.equal((await one(db,"SELECT role FROM user WHERE id='alice'")).role,1);
      assert.equal((await administrator.request('admin/user/status','POST',{id:'admin',status:0})).status,409);
    });
    await t.test('transfer ownership, eligibility and pending-state checks are transactional',async()=>{
      assert.equal((await receiver.request('ven/transfer/perform','POST',{schedule_id:1,new_user_id:'charlie'})).status,403);
      assert.equal((await owner.request('ven/transfer/perform','POST',{schedule_id:1,new_user_id:'charlie'})).status,400);
      const result=await owner.request('ven/transfer/perform','POST',{schedule_id:1,new_user_id:'bob',is_swap:1,s2_id:2});assert.equal(result.status,200);
      changeId=(await one(db,'SELECT id FROM ven_change ORDER BY id DESC LIMIT 1')).id;
      assert.equal((await one(db,'SELECT user_id,status FROM ven_schedule WHERE id=1')).user_id,'bob');
      assert.equal((await receiver.request('ven/transfer/cancel','POST',{change_id:changeId})).status,403);
      assert.equal((await director.request('admin/ven_approve/force_update','POST',{change_id:changeId,status:1})).status,200);
      assert.equal((await one(db,'SELECT status FROM ven_schedule WHERE id=1')).status,1);
      assert.equal((await owner.request('ven/transfer/cancel','POST',{change_id:changeId})).status,409);
    });
    await t.test('stale approvals cannot overwrite newer transfers and cancellation restores both sides',async()=>{
      await rows(db,"INSERT INTO ven_user (user_id,ven_name_sub_id,srt) VALUES ('charlie',1,3)");
      assert.equal((await receiver.request('ven/transfer/perform','POST',{schedule_id:1,new_user_id:'charlie'})).status,200);
      const newer=(await one(db,'SELECT MAX(id) AS id FROM ven_change')).id;
      assert.equal((await director.request('admin/ven_approve/force_update','POST',{change_id:changeId,status:0})).status,409);
      assert.equal((await receiver.request('ven/transfer/cancel','POST',{change_id:newer})).status,200);
      assert.equal((await one(db,'SELECT user_id FROM ven_schedule WHERE id=1')).user_id,'bob');
    });
    await t.test('uploads validate binary contents and DOCX endpoints run without PHP',async()=>{
      const bad=new FormData();bad.set('avatar',new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'],{type:'image/png'}),'fake.png');
      assert.equal((await owner.request('user/profile/upload_avatar','POST',bad)).status,400);
      const template=await fs.readFile(path.join(root,'resources/templates/shift_change_form.docx'));
      const form=new FormData();form.set('kind','shift');form.set('ven_name_id','0');form.set('template',new Blob([template]),'template.docx');
      assert.equal((await administrator.request('admin/templates/upload','POST',form)).status,200);
      assert.equal((await administrator.request('admin/templates/list')).data.templates[0].source,'custom');
      const response=await owner.request('documents/template&kind=shift&ven_name_id=0');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/wordprocessingml/);
      assert.equal((await administrator.request('admin/templates/reset&kind=shift&ven_name_id=0','DELETE')).status,200);
      assert.equal((await administrator.request('admin/backup/sql')).status,200);
      assert.equal((await administrator.request('admin/backup/images')).status,200);
    });
    await t.test('users can enroll MFA, reuse of a TOTP or challenge is denied',async()=>{
      const setup=await owner.request('auth/mfa/setup','POST',{password:'Fixture-password-123'});assert.equal(setup.status,200);
      const confirmed=await owner.request('auth/mfa/confirm','POST',{code:newTotp(setup.data.secret).generate()});assert.equal(confirmed.status,200);
      const recovery=confirmed.data.recovery_codes;
      await owner.request('auth/logout','POST',{});
      assert.equal((await owner.login('alice')).data.enrollment_required,false);
      const sameCode=await owner.request('auth/mfa/verify','POST',{code:newTotp(setup.data.secret).generate()});assert.equal(sameCode.status,401);
      const attempts=await one(db,"SELECT attempts FROM node_challenges WHERE user_id='alice'");assert.equal(attempts.attempts,1);
      const logins=await Promise.all([owner.request('auth/mfa/verify','POST',{code:recovery[0]}),owner.request('auth/mfa/verify','POST',{code:recovery[0]})]);
      assert.deepEqual(logins.map(x=>x.status).sort(),[200,401]);
      assert.equal((await one(db,"SELECT COUNT(*) AS n FROM node_mfa_recovery WHERE user_id='alice'")).n,9);
    });
    await t.test('admin MFA reset requires step-up, revokes target credentials and forces re-enrollment',async()=>{
      const payload={user_id:'alice',password:'Fixture-password-123',code:adminCodes[2]};
      assert.equal((await director.request('admin/user/reset_mfa','POST',payload)).status,403);
      assert.equal((await administrator.request('admin/user/reset_mfa','GET')).status,405);
      assert.equal((await administrator.request('admin/user/reset_mfa','POST',payload,{'X-CSRF-Token':'invalid'})).status,403);
      assert.equal((await administrator.request('admin/user/reset_mfa','POST',{...payload,user_id:'admin'})).status,403);
      assert.equal((await administrator.request('admin/user/reset_mfa','POST',{...payload,password:'wrong'})).status,401);
      assert.equal((await administrator.request('admin/user/reset_mfa','POST',{...payload,code:'invalid'})).status,401);
      assert.ok(await one(db,"SELECT user_id FROM node_mfa WHERE user_id='alice'"));
      const before=await one(db,"SELECT password_hash FROM user WHERE id='alice'");
      const stale=new Browser();const previousLogin=await stale.login('alice');assert.equal(previousLogin.data.enrollment_required,false);
      const result=await administrator.request('admin/user/reset_mfa','POST',payload);assert.equal(result.status,200);assert.equal(result.data.enrollment_required,true);
      assert.equal((await owner.request('auth/me')).status,401);
      assert.equal((await stale.request('auth/mfa/verify','POST',{code:'000000'})).status,401);
      for(const table of ['node_mfa','node_mfa_recovery','node_sessions','node_challenges'])assert.equal((await one(db,`SELECT COUNT(*) AS n FROM ${table} WHERE user_id='alice'`)).n,0);
      assert.equal((await one(db,"SELECT password_hash FROM user WHERE id='alice'")).password_hash,before.password_hash);
      assert.equal((await administrator.request('auth/me')).status,200);
      assert.equal((await one(db,"SELECT requested_by FROM node_mfa_resets WHERE user_id='alice'")).requested_by,'admin');
      const audit=await one(db,"SELECT user_id,description FROM system_logs WHERE action='MFA_RESET' ORDER BY id DESC LIMIT 1");assert.equal(audit.user_id,'admin');assert.ok(audit.description.includes('alice'));
      const client=new Browser();const enrollment=await client.login('alice');assert.equal(enrollment.data.enrollment_required,true);
      assert.equal((await client.request('auth/me')).status,401);
      const confirmed=await client.request('auth/mfa/confirm','POST',{code:newTotp(enrollment.data.secret).generate()});assert.equal(confirmed.status,200);assert.equal(confirmed.data.recovery_codes.length,10);
      assert.equal(await one(db,"SELECT user_id FROM node_mfa_resets WHERE user_id='alice'"),null);
      assert.equal((await client.request('auth/me')).status,200);
      const list=await administrator.request('admin/user/list');assert.equal(list.data.find(user=>user.id==='alice').mfa_enabled,1);
      assert.equal((await administrator.request('admin/user/reset_mfa','POST',payload)).status,401); // consumed admin recovery proof
    });
    await t.test('password reset revokes sessions and outstanding MFA challenges',async()=>{
      const result=await receiver.request('user/profile/password','POST',{old_password:'Fixture-password-123',new_password:'Changed-password-123'});assert.equal(result.status,200);
      assert.equal((await receiver.request('auth/me')).status,401);
      const active=await one(db,"SELECT COUNT(*) AS n FROM node_sessions WHERE user_id='bob'");assert.equal(active.n,0);
    });
    await t.test('MFA attempt limits and expiry cannot be bypassed by submitting the correct code later',async()=>{
      const client=new Browser();await client.login('charlie');
      const setup=await client.request('auth/mfa/setup','POST',{password:'Fixture-password-123'});
      for(let i=0;i<6;i++)assert.equal((await client.request('auth/mfa/confirm','POST',{code:'invalid'})).status,401);
      assert.equal((await one(db,"SELECT attempts FROM node_challenges WHERE user_id='charlie'")).attempts,5);
      assert.equal((await client.request('auth/mfa/confirm','POST',{code:newTotp(setup.data.secret).generate()})).status,401);
      const renewed=await client.request('auth/mfa/setup','POST',{password:'Fixture-password-123'});
      await rows(db,"UPDATE node_challenges SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE user_id='charlie'");
      assert.equal((await client.request('auth/mfa/confirm','POST',{code:newTotp(renewed.data.secret).generate()})).status,401);
      assert.equal(await one(db,"SELECT user_id FROM node_mfa WHERE user_id='charlie'"),null);
    });
    await t.test('recovery code rotation invalidates the old set',async()=>{
      const rotated=await administrator.request('auth/mfa/recovery','POST',{password:'Fixture-password-123',code:adminCodes[0]});assert.equal(rotated.status,200);
      await administrator.request('auth/logout','POST',{});await administrator.login('admin');
      assert.equal((await administrator.request('auth/mfa/verify','POST',{code:adminCodes[1]})).status,401);
      assert.equal((await administrator.request('auth/mfa/verify','POST',{code:rotated.data.recovery_codes[0]})).status,200);
    });
    await t.test('Telegram tokens stay encrypted, HTML is escaped and multiworker claims prevent duplicate sends',async()=>{
      const token='123456789:'+ 'x'.repeat(35);
      assert.equal((await administrator.request('admin/telegram_settings/update','POST',{bot_token:token,chat_id:'123456',notify_confirmed:true,notify_change_request:true,notify_approval:true,
        notify_times:[{send_time:'06:00',notify_day:0,status:1},{send_time:'19:00',notify_day:1,status:1}]})).status,200);
      const stored=await one(db,'SELECT bot_token FROM telegram_settings WHERE id=1');assert.ok(stored.bot_token.startsWith('v1.'));assert.ok(!stored.bot_token.includes(token));
      const settings=await administrator.request('admin/telegram_settings');assert.equal(settings.data.has_bot_token,true);assert.equal(settings.data.bot_token,undefined);
      await rows(db,"UPDATE ven_name SET name='Duty <b>unsafe</b>' WHERE id=1");
      const messages=[];
      const service=new Integrations(db,config,async(url,options)=>{assert.ok(url.startsWith('https://api.telegram.org/bot'));messages.push(JSON.parse(options.body).text);return {ok:true,json:async()=>({ok:true})}});
      const at=new Date('2090-01-20T06:00:00+07:00');
      const preview=await service.notify(at,true);assert.equal(preview.preview.length,1);assert.equal(messages.length,0);
      const results=await Promise.all([service.notify(at),service.notify(at)]);assert.equal(results.reduce((sum,item)=>sum+item.sent,0),1);assert.equal(messages.length,1);assert.ok(messages[0].includes('&lt;b&gt;'));
      const failure=new Integrations(db,config,async()=>{throw Error('network failure')});
      assert.equal((await failure.notify(new Date('2090-01-20T19:00:00+07:00'))).failed,1);
      assert.equal((await failure.notify(new Date('2090-01-20T19:00:00+07:00'))).skipped,1);
    });
    await t.test('brute force attempts are persisted and secrets are absent from audit logs',async()=>{
      for(let i=0;i<8;i++)assert.equal((await guest.request('auth/login','POST',{username:'unknown-user',password:'wrong-password'})).status,401);
      assert.equal((await guest.request('auth/login','POST',{username:'UNKNOWN-USER',password:'wrong-password'})).status,429);
      const logs=JSON.stringify(await rows(db,'SELECT * FROM system_logs'));
      for(const secret of ['Fixture-password-123',adminSecret,...adminCodes])assert.ok(!logs.includes(secret));
    });
  } finally {
    await new Promise(resolve=>server.close(resolve)); await db.end();
    // Database name is generated here and never taken from a production environment.
    for(const name of [databaseName,bootstrapDb]){assert.match(name,/^vengg4_node_test_[a-f0-9]{10}$/);await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)}
    await admin.query("DROP USER IF EXISTS ?@'localhost'",[bootstrapUser]);await admin.end();
    const resolved=await fs.realpath(fixture),temp=await fs.realpath(os.tmpdir());
    if(path.dirname(resolved).toLowerCase()!==temp.toLowerCase()||!path.basename(resolved).startsWith('vengg4-integration-'))throw Error('Unsafe fixture cleanup');
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:1000});
  }
});
