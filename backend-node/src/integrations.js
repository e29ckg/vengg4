import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { JWT } from 'google-auth-library';
import { one, rows, transaction } from './db.js';
import { text, flag, array, integer, fail, json } from './validation.js';
import { encryptSecret, decryptSecret, hash, randomToken } from './security.js';
import { bangkokDay } from './transfers.js';
import { monthBounds } from './scheduling.js';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;','<': '&lt;','>': '&gt;','"': '&quot;',"'": '&#39;' })[c]);
export const addDays = (day, count) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0,10); };
export function validateCredentials(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 65536) fail(400, 'ใช้ service-account JSON ไม่เกิน 64 KB');
  let value; try { value = JSON.parse(buffer.toString('utf8')); } catch { fail(400, 'JSON ไม่ถูกต้อง'); }
  if (value?.type !== 'service_account' || typeof value.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(value.client_email) ||
    value.token_uri !== 'https://oauth2.googleapis.com/token' || (value.universe_domain && value.universe_domain !== 'googleapis.com')) fail(400, 'ข้อมูล Google service-account ไม่ถูกต้อง');
  let key; try { key = createPrivateKey(value.private_key); } catch { fail(400, 'Google private key ไม่ถูกต้อง'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) fail(400, 'ต้องใช้ RSA private key อย่างน้อย 2048 bits');
  return { type: value.type,client_email: value.client_email,private_key: value.private_key,private_key_id: value.private_key_id,
    project_id: value.project_id,token_uri: 'https://oauth2.googleapis.com/token' };
}
export async function atomicWrite(filename, content) {
  await fs.mkdir(path.dirname(filename), { recursive: true,mode: 0o750 });
  const temp = `${filename}.${randomToken()}.tmp`;
  try { await fs.writeFile(temp, content, { mode: 0o600,flag: 'wx' }); await fs.rename(temp, filename); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
export class Integrations {
  constructor(db, config, fetcher = fetch) { this.db = db; this.config = config; this.fetch = fetcher; }
  async telegramConfig() {
    const setting = await one(this.db, 'SELECT * FROM telegram_settings WHERE id=1') || {};
    if (setting.bot_token?.startsWith('v1.')) setting.bot_token = decryptSecret(setting.bot_token, this.config.mfaKey, 'telegram');
    return setting;
  }
  async sendTelegram(message, category, overrides = {}) {
    try {
    const settings = await this.telegramConfig();
    if (category && !Number(settings[category])) return false;
    const token = overrides.bot_token || settings.bot_token, chatId = overrides.chat_id || settings.chat_id;
    if (typeof token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/.test(token) || typeof chatId !== 'string' || !/^(?:-?\d{1,30}|@[A-Za-z0-9_]{3,64})$/.test(chatId)) return false;
      const response = await this.fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST',redirect: 'error',
        headers: { 'content-type': 'application/json' },body: JSON.stringify({ chat_id: chatId,text: message,parse_mode: 'HTML' }),signal: AbortSignal.timeout(15000) });
      return response.ok && (await response.json()).ok === true;
    } catch { return false; }
  }
  async credentials() {
    try {
      const content = await fs.readFile(path.join(this.config.storage, 'google-credentials.enc'), 'utf8');
      return validateCredentials(Buffer.from(decryptSecret(content,this.config.mfaKey,'google')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const old = await fs.readFile(path.join(this.config.legacyData, 'src/Config/credentials.json')).catch(() => null);
      return old ? validateCredentials(old) : null;
    }
  }
  async googleRequest(client, url, method = 'GET', data) {
    // URL always originates here; user-supplied OAuth endpoints are never used.
    return client.request({ url: `https://www.googleapis.com/calendar/v3/${url}`,method,data,timeout: 15000,retry: false });
  }
  async syncGoogle(selectedMonth, onlyDates) {
    const credentials = await this.credentials();
    const calendar = await one(this.db, "SELECT setting_value FROM google_service_settings WHERE setting_key='google_calendar_id'");
    if (!credentials || !calendar?.setting_value) { if (onlyDates) return false; fail(400, 'ตั้งค่า Google credentials และ Calendar ID ก่อน'); }
    const client = new JWT({ email: credentials.client_email,key: credentials.private_key,keyId: credentials.private_key_id,scopes: ['https://www.googleapis.com/auth/calendar.events'] });
    const base = `calendars/${encodeURIComponent(calendar.setting_value)}/events`;
    const bounds = monthBounds(selectedMonth);
    const schedules = await rows(this.db, `SELECT s.ven_date,s.google_event_id,n.name AS duty_name,sub.name AS sub_name,
      CONCAT_WS(' ',CONCAT(IFNULL(p.prefix_name,''),IFNULL(p.first_name,'')),p.last_name) AS full_name
      FROM ven_schedule s JOIN ven_com c ON c.id=s.ven_com_id LEFT JOIN ven_name n ON n.id=c.ven_name_id
      LEFT JOIN ven_name_sub sub ON sub.id=s.ven_name_sub_id LEFT JOIN profile p ON p.user_id=s.user_id
      WHERE s.ven_date>=? AND s.ven_date<? ORDER BY s.ven_date,n.srt,sub.srt,s.id`, bounds);
    const grouped = new Map();
    for (const schedule of schedules) { if (!grouped.has(schedule.ven_date)) grouped.set(schedule.ven_date, []); grouped.get(schedule.ven_date).push(schedule); }
    let updated = 0;
    for (const [day, shifts] of grouped) {
      if (onlyDates && !onlyDates.includes(day)) continue;
      const previousId = shifts.find(shift => shift.google_event_id)?.google_event_id;
      // Keep the persisted Calendar ownership marker/ID format when importing Vengg3 data.
      const id = previousId && /^[a-v0-9]{5,1024}$/.test(previousId) ? previousId : `vengg3${hash(`${calendar.setting_value}:${day}`).slice(0,40)}`;
      const data = { summary: `เวรประจำวันที่ ${day}`,description: shifts.map(shift => `${escapeHtml(shift.duty_name)} / ${escapeHtml(shift.sub_name)}: ${escapeHtml(shift.full_name)}`).join('\n'),
        start: { date: day,timeZone: 'Asia/Bangkok' },end: { date: addDays(day,1),timeZone: 'Asia/Bangkok' },extendedProperties: { private: { vengg3: '1',date: day } } };
      try { await this.googleRequest(client, `${base}/${encodeURIComponent(id)}`, 'PATCH', data); }
      catch (error) {
        if (error.response?.status !== 404) throw new Error('Google Calendar update failed');
        try { await this.googleRequest(client, base, 'POST', { ...data,id }); }
        catch (creationError) { if (creationError.response?.status !== 409) throw new Error('Google Calendar creation failed'); }
      }
      await rows(this.db, 'UPDATE ven_schedule SET google_event_id=? WHERE ven_date=?', [id,day]); updated++;
    }
    // Delete only this application's marked events, never calendar entries belonging to others.
    if (!onlyDates) {
      let pageToken;
      do {
        const params = new URLSearchParams({ privateExtendedProperty: 'vengg3=1',timeMin: `${bounds[0]}T00:00:00+07:00`,timeMax: `${bounds[1]}T00:00:00+07:00`,maxResults: '2500' });
        if (pageToken) params.set('pageToken',pageToken);
        const response = await this.googleRequest(client, `${base}?${params}`);
        for (const event of response.data.items || []) {
          if (event.extendedProperties?.private?.vengg3 === '1' && !grouped.has(event.extendedProperties.private.date)) await this.googleRequest(client, `${base}/${encodeURIComponent(event.id)}`, 'DELETE');
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    }
    return { success: true,updated };
  }
  async afterTransfer(result, category) {
    for (const day of [...new Set([result.date1,result.date2].filter(Boolean))]) await this.syncGoogle(day.slice(0,7),[day]).catch(() => false);
    await this.sendTelegram('📢 มีการเปลี่ยนแปลงคำขอเปลี่ยนเวร กรุณาตรวจสอบในระบบ', category).catch(()=>false);
  }
  async dailyMessages(day, offset) {
    const schedules = await rows(this.db, `SELECT n.name AS duty_name,p.prefix_name,p.first_name,p.last_name FROM ven_schedule s
      JOIN ven_com c ON c.id=s.ven_com_id AND c.status='1' LEFT JOIN ven_name n ON n.id=c.ven_name_id
      LEFT JOIN ven_name_sub sub ON sub.id=s.ven_name_sub_id LEFT JOIN profile p ON p.user_id=s.user_id WHERE s.ven_date=? ORDER BY n.srt,sub.srt,s.id`, [day]);
    if (!schedules.length) return [];
    const header = `📢 <b>เวร${offset ? 'วันพรุ่งนี้' : 'วันนี้'}</b> ${day}\n`, messages = []; let current = header;
    for (const row of schedules) {
      const line = `📌 ${escapeHtml(String(row.duty_name || '').slice(0,200))}: ${escapeHtml(`${row.prefix_name || ''}${row.first_name || ''} ${row.last_name || ''}`.slice(0,200))}\n`;
      if (current.length + line.length > 3500) { messages.push(current); current = header; }
      current += line;
    } messages.push(current); return messages;
  }
  async notify(at = new Date(), dryRun = false) {
    const day = bangkokDay(at), time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok',hour: '2-digit',minute: '2-digit',hour12: false }).format(at);
    const slots = await rows(this.db, "SELECT DISTINCT notify_day FROM telegram_notify_times WHERE status=1 AND TIME_FORMAT(send_time,'%H:%i')=?", [time]);
    const result = { matched: slots.length,sent: 0,skipped: 0,failed: 0,preview: [] };
    for (const slot of slots) {
      const offset = Number(slot.notify_day); if (![0,1].includes(offset)) continue;
      const target = addDays(day,offset), messages = await this.dailyMessages(target,offset);
      if (dryRun) { result.preview.push({ target_date: target,messages }); continue; }
      if (!messages.length) { result.skipped++; continue; }
      const claim = await rows(this.db, "INSERT IGNORE INTO telegram_delivery_log (send_date,send_time,notify_day,target_date,status) VALUES (?,?,?,?,'started')", [day,`${time}:00`,offset,target]);
      if (claim.affectedRows !== 1) { result.skipped++; continue; }
      let count = 0;
      for (const message of messages) { if (!await this.sendTelegram(message)) break; count++; }
      const succeeded = count === messages.length;
      await rows(this.db, 'UPDATE telegram_delivery_log SET status=?,message_count=?,finished_at=NOW() WHERE send_date=? AND send_time=? AND notify_day=?', [succeeded ? 'sent' : 'failed',count,day,`${time}:00`,offset]);
      result[succeeded ? 'sent' : 'failed']++;
    } return result;
  }
}

export function registerIntegrations(route, db, config, service) {
  route('admin/telegram_settings', 'GET', [9], async () => {
    const setting = await one(db, 'SELECT * FROM telegram_settings WHERE id=1') || {};
    const { bot_token,...publicSetting } = setting;
    return { ...publicSetting,has_bot_token: !!bot_token,notify_times: await rows(db, 'SELECT * FROM telegram_notify_times ORDER BY send_time') };
  });
  route('admin/telegram_settings/update', 'POST', [9], async req => {
    const body = req.body, chat = text(body.chat_id, 'chat_id', 100, true), token = text(body.bot_token, 'bot_token', 255, true);
    if (token && !/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/.test(token)) fail(400, 'Bot token ไม่ถูกต้อง');
    if (body.clear_bot_token && token) fail(400, 'ไม่สามารถล้างและตั้ง token พร้อมกัน');
    const slots = array(body.notify_times || [],100).map(slot => {
      const time = text(slot.send_time, 'เวลา', 8);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(time)) fail(400, 'เวลาแจ้งเตือนไม่ถูกต้อง');
      return [time,flag(slot.notify_day),Number(!!slot.status)];
    });
    await transaction(db, async connection => {
      await rows(connection, 'UPDATE telegram_settings SET chat_id=?,notify_confirmed=?,notify_change_request=?,notify_approval=? WHERE id=1', [chat,Number(!!body.notify_confirmed),Number(!!body.notify_change_request),Number(!!body.notify_approval)]);
      if (token || body.clear_bot_token === true) await rows(connection, 'UPDATE telegram_settings SET bot_token=? WHERE id=1', [token ? encryptSecret(token,config.mfaKey,'telegram') : '']);
      await rows(connection, 'DELETE FROM telegram_notify_times');
      for (const slot of slots) await rows(connection, 'INSERT INTO telegram_notify_times (send_time,notify_day,status) VALUES (?,?,?)', slot);
    }); return { success: true };
  });
  route('admin/telegram_settings/test', 'POST', [9], async req => {
    const overrides = { bot_token: text(req.body.bot_token, 'token', 255, true),chat_id: text(req.body.chat_id, 'chat_id', 100, true) };
    if (!await service.sendTelegram('✅ ทดสอบระบบแจ้งเตือนเวร', null, overrides)) fail(400, 'ส่งไม่สำเร็จ ตรวจ Token และ Chat ID'); return { success: true };
  });
  route('admin/telegram_settings/manual_notify', 'POST', [9], async req => {
    const offset = flag(req.body.day_offset ?? 0), day = addDays(bangkokDay(),offset), messages = await service.dailyMessages(day,offset);
    if (!messages.length) fail(404, 'ไม่มีเวรที่ยืนยันแล้วในวันที่เลือก');
    for (const message of messages) if (!await service.sendTelegram(message)) fail(502, 'ส่ง Telegram ไม่สำเร็จ');
    return { success: true };
  });
  route('admin/google_settings/get', 'GET', [9], async () => Object.fromEntries((await rows(db, 'SELECT setting_key,setting_value FROM google_service_settings')).map(row => [row.setting_key,row.setting_value])));
  route('admin/google_settings/update', 'POST', [9], async req => {
    await transaction(db, async connection => { for (const key of ['google_service_account','google_calendar_id']) {
      const value = text(req.body[key], key, 255, true);
      await rows(connection, 'INSERT INTO google_service_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', [key,value]);
    } }); return { success: true };
  });
  route('admin/google_settings/upload', 'POST', [9], async req => {
    const credentials = validateCredentials(req.file?.buffer);
    await atomicWrite(path.join(config.storage,'google-credentials.enc'),encryptSecret(JSON.stringify(credentials),config.mfaKey,'google'));
    await rows(db, "INSERT INTO google_service_settings (setting_key,setting_value) VALUES ('google_service_account',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [credentials.client_email]);
    return { success: true,client_email: credentials.client_email };
  }, 'credential_file');
}
