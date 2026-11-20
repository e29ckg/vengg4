import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authenticate, enforceCsrf, issueCsrf, limit, cookieNames, cookies } from './security.js';
import { AuthService } from './auth.js';
import { one, rows, audit } from './db.js';
import { HttpError, fail } from './validation.js';
import { registerUsersSettings } from './users-settings.js';
import { registerScheduling } from './scheduling.js';
import { registerTransfers } from './transfers.js';
import { registerFiles, avatarDirectories } from './files.js';
import { Integrations, registerIntegrations } from './integrations.js';

export function createApp({ db, config, integrations = new Integrations(db,config) }) {
  const app = express(), registry = new Map(), auth = new AuthService(db,config);
  app.disable('x-powered-by'); app.set('trust proxy',config.trustProxy ? (config.trustedProxies||['loopback']) : false);
  app.use(helmet({ hsts: config.production ? undefined : false,contentSecurityPolicy: {
    directives: { defaultSrc: ["'self'"],scriptSrc: ["'self'"],styleSrc: ["'self'","'unsafe-inline'",'https://fonts.googleapis.com','https://cdn.jsdelivr.net'],
      imgSrc: ["'self'",'data:','blob:','https://ui-avatars.com'],fontSrc: ["'self'",'https://fonts.gstatic.com','https://cdn.jsdelivr.net'],
      connectSrc: ["'self'"],frameAncestors: ["'none'"],objectSrc: ["'none'"],upgradeInsecureRequests: config.production ? [] : null } } }));
  app.get('/healthz',async(req,res)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.sendStatus(403);
    res.set('Cache-Control','no-store');
    try{await one(db,'SELECT 1 AS ok');res.json({status:'ok'})}catch{res.status(503).json({status:'unavailable'})}
  });
  app.use((req,res,next) => {
    req.requestId = randomUUID(); res.set('X-Request-Id',req.requestId);
    if (config.production && !req.secure) return next(new HttpError(400,'HTTPS required'));
    const origin = req.get('origin');
    if (origin && !config.allowedOrigins.has(origin)) return next(new HttpError(403,'Origin ไม่ได้รับอนุญาต'));
    if (origin) { res.set('Access-Control-Allow-Origin',origin); res.set('Access-Control-Allow-Credentials','true'); res.vary('Origin'); }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers','Content-Type,X-CSRF-Token'); return res.sendStatus(origin ? 204 : 403);
    } next();
  });
  app.use(express.json({ limit: '1mb',strict: true,type: ['application/json','application/*+json'] }));
  const route = (name,methods,roles,handler,upload) => {
    if (registry.has(name)) throw new Error(`Duplicate route: ${name}`);
    registry.set(name,{ methods,roles,handler,upload });
  };
  route('test','GET',false,async () => { await one(db,'SELECT 1 AS ok'); return { status: 'success',message: 'Node.js backend is working' }; });
  route('auth/csrf','GET',false,(req,res) => issueCsrf(req,res,config));
  route('auth/login','POST',false,(req,res) => auth.login(req,res));
  route('auth/mfa/verify','POST',false,(req,res) => auth.verify(req,res,false));
  route('auth/mfa/confirm','POST',false,(req,res) => auth.verify(req,res,true));
  route('auth/mfa/setup','POST',null,(req,res) => auth.setup(req,res));
  route('auth/mfa/status','GET',null,req => auth.status(req));
  route('auth/mfa/disable','POST',null,(req,res) => auth.changeMfa(req,res,true));
  route('auth/mfa/recovery','POST',null,(req,res) => auth.changeMfa(req,res,false));
  route('admin/user/reset_mfa','POST',[9],req => auth.resetUserMfa(req));
  route('auth/me','GET',null,req => ({ success: true,user_id: req.user.id,username: req.user.username,role: Number(req.user.role) }));
  route('auth/logout','POST',null,(req,res) => auth.logout(req,res));
  route('user/profile/password','POST',null,(req,res) => auth.changePassword(req,res));
  registerUsersSettings(route,db); registerScheduling(route,db,integrations); registerTransfers(route,db,integrations);
  registerFiles(route,db,config); registerIntegrations(route,db,config,integrations);
  route('public/latest_update','GET',null,async () => {
    const row = await one(db, `SELECT l.created_at AS latest_update,p.prefix_name,p.first_name,p.last_name FROM system_logs l
      LEFT JOIN profile p ON p.user_id=l.user_id WHERE l.module IN ('SCHEDULE','TRANSFER','APPROVE') ORDER BY l.id DESC LIMIT 1`);
    return row || { latest_update: null };
  });
  route('admin/program/status','GET',[9],async () => {
    let latest = '';
    const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.UPDATE_REPOSITORY || '') ? process.env.UPDATE_REPOSITORY : '';
    try {
      if (repository) {
        const response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, { headers: { Accept: 'application/vnd.github+json','User-Agent': 'vengg4' },signal: AbortSignal.timeout(8000) });
        if (response.ok) { const data = await response.json(); if (/^[a-f0-9]{40}$/.test(data.sha)) latest = data.sha; }
      }
    } catch { /* Offline installations can still read their own deployment status. */ }
    const current = process.env.APP_COMMIT || 'unknown';
    return { current,latest: latest || 'unknown',repository,available: !!latest && current !== latest,canUpdate: false,branch: 'main',dirty: false,
      updateMode: 'deployment',message: 'อัปเดต Node.js ผ่านกระบวนการ deploy และ restart service ตาม README.md เว็บไม่มีสิทธิ์รันคำสั่ง Git/npm บนเซิร์ฟเวอร์' };
  });
  route('admin/program/update','POST',[9],() => fail(409,'ใช้ขั้นตอน deploy ใน README.md เพื่ออัปเดต Node.js และ restart service อย่างปลอดภัย'));
  const upload = multer({ storage: multer.memoryStorage(),limits: { fileSize: 2097152,files: 1,fields: 30,fieldSize: 65536,parts: 35 } });
  let activeUploads = 0;
  async function dispatch(req,res,next) {
    let uploading = false;
    try {
      res.set('Cache-Control','no-store');
      const name = req.query.route !== undefined ? req.query.route : req.path.replace(/^\//,'');
      if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z0-9_/-]+$/.test(name)) fail(404,'Endpoint not found');
      const entry = registry.get(name); if (!entry) fail(404,'Endpoint not found');
      const methods = typeof entry.methods === 'function' ? entry.methods(req) : Array.isArray(entry.methods) ? entry.methods : [entry.methods];
      if (!methods.includes(req.method)) { res.set('Allow',methods.join(', ')); fail(405,'Method not allowed'); }
      enforceCsrf(req,config);
      if (entry.roles !== false) {
        req.user = await authenticate(db,req,config);
        const roles = typeof entry.roles === 'function' ? entry.roles(req) : entry.roles;
        if (roles && !roles.includes(Number(req.user.role))) fail(403,'ไม่มีสิทธิ์ใช้งาน');
      }
      if (entry.upload) {
        await limit(db,`upload:${req.user.id}`,10,60);
        if (activeUploads >= 4) fail(429,'มีการอัปโหลดพร้อมกันมากเกินไป');
        activeUploads++; uploading = true;
        await new Promise((resolve,reject) => upload.single(entry.upload)(req,res,error => error ? reject(error) : resolve()));
      } else if (['POST','PUT'].includes(req.method) && !req.is('application/json')) fail(415,'ใช้ Content-Type application/json');
      req.body ??= {};
      const result = await entry.handler(req,res);
      if (req.user && ['POST','PUT','DELETE'].includes(req.method) && !name.startsWith('auth/') && name !== 'user/profile/password') {
        await audit(db,req.user,'UPDATE',name.includes('schedule') ? 'SCHEDULE' : 'API',name,req.ip).catch(() => console.error('Audit persistence failed',req.requestId));
      }
      if (!res.headersSent) res.json(result ?? { success: true });
    } catch (error) { next(error); }
    finally { if (uploading) activeUploads--; }
  }
  // Only generated image filenames are public; never expose arbitrary storage files.
  const serveAvatar = async (req,res,next) => {
    try {
      const filename = req.params.filename;
      if (!/^[A-Za-z0-9_-]+\.(jpe?g|png|gif|webp)$/i.test(filename)) fail(404,'Not found');
      for (const directory of avatarDirectories(config)) {
        const file = path.join(directory,filename), stat = await fs.lstat(file).catch(() => null);
        if (stat?.isFile() && !stat.isSymbolicLink()) { res.set('X-Content-Type-Options','nosniff'); return res.sendFile(file); }
      } fail(404,'Not found');
    } catch (error) { next(error); }
  };
  app.get(['/api/uploads/avatars/:filename','/vengg4/api/uploads/avatars/:filename','/uploads/avatars/:filename','/vengg4/uploads/avatars/:filename'],serveAvatar);
  app.use(['/api','/vengg4/api'],dispatch);
  app.use((req,res,next) => req.query.route !== undefined ? dispatch(req,res,next) : next());
  app.use(['/assets','/vengg4/assets'],express.static(path.join(config.frontend,'assets'),{ immutable: true,maxAge: '1y',dotfiles: 'deny' }));
  app.use(['/templates','/vengg4/templates'],express.static(path.join(config.frontend,'templates'),{ dotfiles: 'deny' }));
  app.get(['/favicon.svg','/vengg4/favicon.svg'],(req,res) => res.sendFile(path.join(config.frontend,'favicon.svg')));
  app.use((req,res,next) => {
    if (req.method !== 'GET') return next(new HttpError(404,'Not found'));
    if (/(?:^|\/)(?:backend(?:-node)?|deploy|\.git|\.env|install[^/]*\.php)(?:\/|$)|\.(?:php|sql|json|ya?ml|ps1|cmd|md)$/i.test(req.path)) return next(new HttpError(404,'Not found'));
    res.set('Cache-Control','no-store'); res.sendFile(path.join(config.frontend,'index.html'),error => { if (error) next(new HttpError(404,'Frontend not built')); });
  });
  app.use((error,req,res,next) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof HttpError ? error.status : error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof SyntaxError || error instanceof multer.MulterError ? 400 : error.code === 'ER_DUP_ENTRY' ? 409 : 500;
    if (status === 429) res.set('Retry-After','900');
    if (status === 500) console.error('API failure', { requestId: req.requestId,code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'INTERNAL' });
    res.status(status).json({ error: error instanceof HttpError ? error.message : status === 500 ? 'เกิดข้อผิดพลาดภายในระบบ' : status === 413 ? 'ข้อมูลมีขนาดใหญ่เกินไป' : status === 409 ? 'ข้อมูลซ้ำ' : 'ข้อมูลไม่ถูกต้อง',
      ...(error.code === 'MAINTENANCE' ? { error: 'MAINTENANCE',message: error.message } : {}),...(['CSRF','AUTH_REQUIRED'].includes(error.code) ? { code: error.code } : {}) });
  });
  app.locals.routes = registry;
  return app;
}
