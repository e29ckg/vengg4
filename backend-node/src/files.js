import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import yauzl from 'yauzl';
import yazl from 'yazl';
import mysql from 'mysql2';
import { one, rows } from './db.js';
import { integer, fail } from './validation.js';
import { atomicWrite } from './integrations.js';
import { randomToken } from './security.js';
import { root } from './config.js';

export async function validateDocx(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 2097152 || !/\.docx$/i.test(filename || '')) fail(400, 'ใช้ DOCX ไม่เกิน 2 MB');
  await new Promise((resolve,reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true,validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let entries = 0, total = 0, decoded = 0, document = false, types = false;
      const seen = new Set();
      const abort = error => { zip.close(); reject(error); };
      zip.on('error',abort);
      zip.on('entry', async entry => {
        try {
          const name = entry.fileName;
          if (++entries > 2000 || (total += entry.uncompressedSize) > 20971520 || seen.has(name) || /(?:^\/|\\|(?:^|\/)\.\.(?:\/|$))/.test(name) ||
              /vbaProject|word\/activeX\/|word\/embeddings\//i.test(name) || (entry.generalPurposeBitFlag & 1)) throw new Error('Unsafe DOCX entry');
          seen.add(name);
          if (!name.endsWith('/')) {
            const stream = await new Promise((resolve,reject) => zip.openReadStream(entry, (error,stream) => error ? reject(error) : resolve(stream)));
            const chunks = []; let size = 0;
            for await (const chunk of stream) {
              decoded += chunk.length; size += chunk.length;
              if (decoded > 20971520 || size > entry.uncompressedSize) { stream.destroy(); throw new Error('DOCX size exceeded'); }
              if (/\.(xml|rels)$/i.test(name)) chunks.push(chunk);
            }
            const content = Buffer.concat(chunks).toString('utf8');
            if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content) || (/\.rels$/i.test(name) && /TargetMode\s*=\s*["']External["']/i.test(content))) throw new Error('External XML is not allowed');
            if (name === 'word/document.xml') document = true;
            if (name === '[Content_Types].xml') types = content.includes('wordprocessingml.document.main+xml') && !/macroEnabled|vbaProject/i.test(content);
          }
          zip.readEntry();
        } catch (error) { abort(error); }
      });
      zip.on('end', () => document && types ? resolve() : reject(new Error('Not a Word document')));
      zip.readEntry();
    });
  }).catch(() => fail(400, 'DOCX ไม่ถูกต้อง มี macro/ไฟล์ภายนอก หรือข้อมูลขยายเกินขนาด'));
}
async function exists(filename) { try { return (await fs.stat(filename)).isFile(); } catch { return false; } }
export const avatarDirectories = config => [path.join(config.storage,'avatars'),path.join(config.legacyData,'public/uploads/avatars')];
export function registerFiles(route, db, config) {
  route('user/profile/upload_avatar', 'POST', null, async req => {
    if (!req.file || !/\.(jpe?g|png|webp)$/i.test(req.file.originalname)) fail(400, 'ใช้รูป JPEG, PNG หรือ WebP');
    let image;
    try {
      const decoded=sharp(req.file.buffer,{limitInputPixels:20000000,animated:false});
      const metadata=await decoded.metadata();
      if(!['jpeg','png','webp'].includes(metadata.format))fail(400,'ชนิดรูปภาพไม่ถูกต้อง');
      image=await decoded.rotate().resize(512,512,{fit:'cover'}).webp({quality:85}).toBuffer();
    }
    catch { fail(400, 'รูปภาพไม่ถูกต้องหรือมีขนาดใหญ่เกินไป'); }
    const name = `${randomToken()}.webp`;
    await atomicWrite(path.join(config.storage,'avatars',name),image);
    await rows(db, 'UPDATE profile SET avatar=? WHERE user_id=?', [name,req.user.id]);
    return { success: true,avatar: name };
  }, 'avatar');
  async function scope(input) {
    const kind = input.kind, id = integer(input.ven_name_id ?? 0,'ประเภทเวร',0);
    if (!['shift','duty'].includes(kind) || (kind === 'shift' && id !== 0)) fail(400, 'ประเภทเทมเพลดไม่ถูกต้อง');
    if (id > 0 && !await one(db, 'SELECT id FROM ven_name WHERE id=?', [id])) fail(404, 'ไม่พบประเภทเวร');
    return { kind,id,name: kind === 'shift' ? 'shift-change.docx' : id ? `duty-${id}.docx` : 'duty-default.docx' };
  }
  const customPath = scope => path.join(config.storage,'document-templates',scope.name);
  async function choose(scope) {
    if (await exists(customPath(scope))) return { file: customPath(scope),source: 'custom' };
    if (scope.kind === 'duty' && scope.id > 0) {
      const global = path.join(config.storage,'document-templates/duty-default.docx');
      if (await exists(global)) return { file: global,source: 'global' };
    }
    return { file: path.join(root,'resources/templates',scope.kind === 'shift' ? 'shift_change_form.docx' : 'duty_report_form.docx'),source: 'bundled' };
  }
  async function metadata(kind, id, label) {
    const s = await scope({ kind,ven_name_id: id }), selected = await choose(s), stat = await fs.stat(selected.file);
    let valid = true, validation_error = null;
    try { await validateDocx(await fs.readFile(selected.file),selected.file); } catch (error) { valid = false; validation_error = error.message; }
    return { kind,ven_name_id: id,label,custom: selected.source === 'custom',source: selected.source,size: stat.size,updated_at: selected.source === 'custom' ? stat.mtime.toISOString() : null,valid,validation_error };
  }
  route('admin/templates/list', 'GET', [9], async () => {
    const templates = [await metadata('shift',0,'ใบเปลี่ยนเวร'),await metadata('duty',0,'รายงานเวรเริ่มต้น')];
    for (const row of await rows(db, 'SELECT id,name FROM ven_name WHERE status=1 ORDER BY srt,id')) templates.push(await metadata('duty',row.id,row.name));
    return { templates };
  });
  route('documents/template', 'GET', null, async (req,res) => {
    const selected = await choose(await scope(req.query));
    await validateDocx(await fs.readFile(selected.file),selected.file);
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.attachment('vengg4-template.docx'); await pipeline(createReadStream(selected.file),res);
  });
  for (const action of ['upload','validate']) route(`admin/templates/${action}`, 'POST', [9], async req => {
    const selected = await scope(req.body);
    if (!req.file) fail(400, 'กรุณาเลือก DOCX');
    await validateDocx(req.file.buffer,req.file.originalname);
    if (action === 'upload') await atomicWrite(customPath(selected),req.file.buffer);
    return { success: true };
  }, 'template');
  route('admin/templates/reset', 'DELETE', [9], async req => {
    await fs.unlink(customPath(await scope(req.query))).catch(error => { if (error.code !== 'ENOENT') throw error; }); return { success: true };
  });
  route('admin/backup/images', 'GET', [9], async (req,res) => {
    const zip = new yazl.ZipFile(), names = new Set();
    for (const directory of avatarDirectories(config)) {
      for (const entry of await fs.readdir(directory,{ withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.(jpe?g|png|gif|webp)$/i.test(entry.name) || names.has(entry.name)) continue;
        names.add(entry.name); zip.addFile(path.join(directory,entry.name),`avatars/${entry.name}`);
      }
    }
    res.type('application/zip').attachment('vengg4-images.zip');
    const done = pipeline(zip.outputStream,res); zip.end(); await done;
  });
  route('admin/backup/sql', 'GET', [9], async (req,res) => {
    const connection = await db.getConnection();
    const write = async value => { if (res.destroyed) throw new Error('Client disconnected'); if (!res.write(value)) await once(res,'drain'); };
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.beginTransaction();
      const [tables] = await connection.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'");
      res.type('application/sql').attachment('vengg4-backup.sql');
      await write('-- Vengg4 backup. Contains confidential data. Session tokens are excluded.\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n');
      for (const entry of tables) {
        const table = Object.values(entry)[0]; if (!/^[A-Za-z0-9_]+$/.test(table)) continue;
        const [ddl] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
        await write(`\nDROP TABLE IF EXISTS \`${table}\`;\n${ddl[0]['Create Table']};\n`);
        if (['node_sessions','node_challenges','node_rate_limits'].includes(table)) continue;
        for (let offset = 0; ; offset += 500) {
          const batch = await rows(connection, `SELECT * FROM \`${table}\` LIMIT ?,500`, [offset]);
          for (const row of batch) {
            if (table === 'user') row.auth_key = null;
            const keys = Object.keys(row), values = keys.map(key => {
              const value = row[key]; return mysql.escape(value !== null && typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
            });
            await write(`INSERT INTO \`${table}\` (${keys.map(key => mysql.escapeId(key)).join(',')}) VALUES (${values.join(',')});\n`);
          }
          if (batch.length < 500) break;
        }
      }
      await write('SET FOREIGN_KEY_CHECKS=1;\n'); await connection.commit(); res.end();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });
}
