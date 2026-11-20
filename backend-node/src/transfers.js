import { one, rows, transaction, audit } from './db.js';
import { integer, text, flag, fail } from './validation.js';
import { changeSql } from './scheduling.js';

export const bangkokDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok',year: 'numeric',month: '2-digit',day: '2-digit' }).format(now);
export async function lockSchedules(db, ids) {
  const result = new Map();
  for (const id of [...new Set(ids)].sort((a,b) => a - b)) {
    const schedule = await one(db, 'SELECT * FROM ven_schedule WHERE id=? FOR UPDATE', [id]);
    if (!schedule) fail(404, 'ไม่พบเวร');
    result.set(Number(id), schedule);
  } return result;
}
async function requestAndSchedules(db, id) {
  const change = await one(db, 'SELECT * FROM ven_change WHERE id=?', [id]);
  if (!change) fail(404, 'ไม่พบคำขอ');
  const ids = change.is_swap ? [change.s1_id,change.s2_id] : [change.s1_id];
  const schedules = await lockSchedules(db, ids);
  const locked = await one(db, 'SELECT * FROM ven_change WHERE id=? FOR UPDATE', [id]);
  if (!locked || locked.s1_id !== change.s1_id || locked.s2_id !== change.s2_id) fail(409, 'คำขอเปลี่ยนแปลงแล้ว');
  for (const scheduleId of ids) {
    const schedule = schedules.get(Number(scheduleId));
    const expected = Number(scheduleId) === Number(change.s1_id) ? change.user2_id : change.user1_id;
    if (schedule.user_id !== expected || ![1,2].includes(Number(schedule.status))) fail(409, 'เวรเปลี่ยนแปลงแล้ว');
    if (await one(db, 'SELECT id FROM ven_change WHERE id>? AND status IN (0,1) AND (s1_id=? OR s2_id=?) LIMIT 1', [id,scheduleId,scheduleId])) fail(409, 'มีคำขอใหม่กว่าในเวรนี้');
  }
  return { change: locked,ids,schedules };
}
export function registerTransfers(route, db, integrations) {
  route('ven/transfer/perform', 'POST', null, async req => {
    const firstId = integer(req.body.schedule_id), targetUser = text(req.body.new_user_id, 'ผู้รับเวร', 36), swap = flag(req.body.is_swap ?? 0);
    const secondId = req.body.s2_id ? integer(req.body.s2_id) : null;
    if (targetUser === req.user.id || (swap && (!secondId || secondId === firstId)) || (!swap && secondId)) fail(400, 'ข้อมูลเปลี่ยนเวรไม่ถูกต้อง');
    const result = await transaction(db, async connection => {
      // Serialize changes for both users before checking eligibility and their shifts.
      for (const userId of [req.user.id,targetUser].sort()) {
        if (!await one(connection, 'SELECT id FROM user WHERE id=? AND status=10 AND is_deleted=0 FOR UPDATE', [userId])) fail(400, 'ผู้ใช้ไม่พร้อมรับเวร');
      }
      const schedules = await lockSchedules(connection, swap ? [firstId,secondId] : [firstId]);
      const first = schedules.get(firstId), second = swap ? schedules.get(secondId) : null;
      if (first.user_id !== req.user.id || (second && second.user_id !== targetUser)) fail(403, 'ไม่มีสิทธิ์เปลี่ยนเวรนี้');
      if (first.status !== 1 || (second && second.status !== 1)) fail(409, 'เวรนี้ไม่พร้อมเปลี่ยน');
      const settings = await one(connection, 'SELECT allow_swap,advance_swap_days,allow_retroactive_swap FROM system_settings WHERE id=1') || {};
      if (Number(settings.allow_swap ?? 1) !== 1) fail(403, 'ระบบปิดการเปลี่ยนเวร');
      const today = bangkokDay();
      for (const schedule of [first,second].filter(Boolean)) {
        const command = await one(connection, 'SELECT status FROM ven_com WHERE id=?', [schedule.ven_com_id]);
        if (String(command?.status) !== '1') fail(403, 'ยังไม่ยืนยันคำสั่งเวร');
        const days = Math.round((Date.parse(`${schedule.ven_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
        if (days < 0 && !Number(settings.allow_retroactive_swap)) fail(403, 'ไม่อนุญาตให้เปลี่ยนเวรย้อนหลัง');
        if (days >= 0 && days < Math.max(0, Number(settings.advance_swap_days ?? 3))) fail(403, 'เปลี่ยนเวรล่วงหน้าไม่ครบวันที่กำหนด');
      }
      const eligible = (user, sub) => one(connection, 'SELECT id FROM ven_user WHERE user_id=? AND ven_name_sub_id=? LIMIT 1', [user,sub]);
      if (!await eligible(targetUser, first.ven_name_sub_id) || (second && !await eligible(req.user.id,second.ven_name_sub_id))) fail(400, 'ผู้รับไม่มีสิทธิ์ในหน้าที่นี้');
      if (await one(connection, 'SELECT id FROM ven_change WHERE status=0 AND (s1_id=? OR s2_id=? OR s1_id=? OR s2_id=?) LIMIT 1', [firstId,firstId,secondId,secondId])) fail(409, 'มีคำขอรออนุมัติแล้ว');
      const inserted = await rows(connection, 'INSERT INTO ven_change (change_no,s1_id,user1_id,user2_id,is_swap,s2_id,status) VALUES (NULL,?,?,?,?,?,0)', [firstId,req.user.id,targetUser,swap,secondId]);
      const changeNo = `CH-${today.slice(0,7).replace('-','')}-${inserted.insertId}`;
      await rows(connection, 'UPDATE ven_change SET change_no=? WHERE id=?', [changeNo,inserted.insertId]);
      await rows(connection, 'UPDATE ven_schedule SET user_id=?,status=2 WHERE id=?', [targetUser,firstId]);
      if (second) await rows(connection, 'UPDATE ven_schedule SET user_id=?,status=2 WHERE id=?', [req.user.id,secondId]);
      await audit(connection, req.user, 'CREATE', 'TRANSFER', `Transfer ${changeNo}`, req.ip);
      return { success: true,change_no: changeNo,date1: first.ven_date,date2: second?.ven_date || null };
    });
    await integrations.afterTransfer(result, 'notify_change_request'); return result;
  });
  route('ven/transfer/cancel', 'POST', null, async req => {
    const id = integer(req.body.change_id);
    const result = await transaction(db, async connection => {
      const { change,ids,schedules } = await requestAndSchedules(connection, id);
      if (change.user1_id !== req.user.id) fail(403, 'ไม่มีสิทธิ์ยกเลิกคำขอนี้');
      if (change.status !== 0 || ids.some(scheduleId => schedules.get(Number(scheduleId)).status !== 2)) fail(409, 'ยกเลิกได้เฉพาะคำขอรออนุมัติ');
      await rows(connection, 'UPDATE ven_schedule SET user_id=?,status=1 WHERE id=?', [change.user1_id,change.s1_id]);
      if (change.is_swap) await rows(connection, 'UPDATE ven_schedule SET user_id=?,status=1 WHERE id=?', [change.user2_id,change.s2_id]);
      await rows(connection, 'DELETE FROM ven_change WHERE id=? AND status=0', [id]);
      await audit(connection, req.user, 'DELETE', 'TRANSFER', `Canceled transfer ${id}`, req.ip);
      return { success: true,date1: schedules.get(Number(change.s1_id)).ven_date,date2: change.s2_id ? schedules.get(Number(change.s2_id)).ven_date : null };
    });
    await integrations.afterTransfer(result, 'notify_change_request'); return result;
  });
  route('admin/ven_approve/list', 'GET', [2,9], () => rows(db, changeSql + ' ORDER BY vc.status,vc.created_at DESC'));
  route('admin/ven_approve/force_update', 'POST', [2,9], async req => {
    const id = integer(req.body.change_id), status = flag(req.body.status ?? 1);
    await transaction(db, async connection => {
      const { change,ids } = await requestAndSchedules(connection,id);
      if (![0,1].includes(Number(change.status))) fail(409, 'สถานะคำขอไม่ถูกต้อง');
      for (const scheduleId of ids) await rows(connection, 'UPDATE ven_schedule SET status=? WHERE id=?', [status ? 1 : 2,scheduleId]);
      await rows(connection, 'UPDATE ven_change SET status=? WHERE id=?', [status,id]);
      await audit(connection, req.user, 'UPDATE', 'APPROVE', `Approval ${id}: ${status}`, req.ip);
    });
    await integrations.sendTelegram('📢 มีการอัปเดตสถานะคำขอเปลี่ยนเวร', 'notify_approval').catch(() => false);
    return { success: true };
  });
}
