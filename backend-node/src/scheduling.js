import { one, rows, transaction } from './db.js';
import { integer, text, flag, date, month, array, fail } from './validation.js';
import { updateColumns, orderRows } from './users-settings.js';

const nameSql = alias => `CONCAT_WS(' ',CONCAT(IFNULL(${alias}.prefix_name,''),IFNULL(${alias}.first_name,'')),${alias}.last_name)`;
export const scheduleSql = `SELECT s.*,s.ven_date AS date,DAY(s.ven_date) AS day,s.ven_com_id AS com_id,s.ven_name_sub_id AS sub_id,
  ${nameSql('p')} AS full_name,${nameSql('p')} AS user_name,${nameSql('p')} AS title,p.position,p.avatar AS profile_image,
  sub.name AS duty_role,sub.name AS sub_name,sub.color,sub.color AS backgroundColor,sub.price,
  n.id AS ven_name_id,n.name AS ven_name,n.name AS duty_main,n.name_full AS duty_main_full,n.dn AS shift_type,
  c.com_num,c.com_num AS command_num,c.com_date AS command_date,c.ven_month AS command_month,c.status AS com_status,
  SUBSTRING_INDEX(SUBSTRING_INDEX(n.dn,'(',-1),')',1) AS time_period,
  REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(n.dn,'(',-1),')',1),'-',1),'.',':') AS ven_time,
  REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(n.dn,'(',-1),')',1),'-',' - ') AS ven_time_text
  FROM ven_schedule s LEFT JOIN profile p ON p.user_id=s.user_id LEFT JOIN ven_name_sub sub ON sub.id=s.ven_name_sub_id
  LEFT JOIN ven_com c ON c.id=s.ven_com_id LEFT JOIN ven_name n ON n.id=c.ven_name_id`;
export const changeSql = `SELECT vc.*,vc.id AS change_id,vc.created_at AS change_date,vs.ven_date,vs.ven_date AS s1_date,vs2.ven_date AS s2_date,
  vn.name AS duty_main,vn.name_full AS duty_main_full,vns.name AS duty_role,vcom.com_num,vcom.com_date,
  ${nameSql('p1')} AS user1_name,${nameSql('p2')} AS user2_name,p1.position AS user1_dep,p2.position AS user2_dep,
  REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(vn.dn,'(',-1),')',1),'-',1),'.',':') AS ven_time,
  REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(vn.dn,'(',-1),')',1),'-',' - ') AS ven_time_text,
  (SELECT prev.change_no FROM ven_change prev WHERE (prev.s1_id=vc.s1_id OR prev.s2_id=vc.s1_id) AND prev.status=1 AND prev.id<vc.id ORDER BY prev.id DESC LIMIT 1) AS ref_change_no
  FROM ven_change vc LEFT JOIN ven_schedule vs ON vs.id=vc.s1_id LEFT JOIN ven_schedule vs2 ON vs2.id=vc.s2_id
  LEFT JOIN ven_name_sub vns ON vns.id=vs.ven_name_sub_id LEFT JOIN ven_com vcom ON vcom.id=vs.ven_com_id
  LEFT JOIN ven_name vn ON vn.id=vcom.ven_name_id LEFT JOIN profile p1 ON p1.user_id=vc.user1_id LEFT JOIN profile p2 ON p2.user_id=vc.user2_id`;
export async function fullDuties(db) {
  const [names,subs] = await Promise.all([rows(db, 'SELECT * FROM ven_name WHERE status=1 ORDER BY srt,id'),rows(db, 'SELECT * FROM ven_name_sub WHERE status=1 ORDER BY srt,id')]);
  return names.map(name => ({ ...name, subs: subs.filter(sub => sub.ven_name_id === name.id) }));
}
export const monthBounds = input => { const m = month(input), next = new Date(`${m}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); return [`${m}-01`,next.toISOString().slice(0,10)]; };
const orderSchedule = ' ORDER BY s.ven_date,n.srt,sub.srt,s.id';
export function registerScheduling(route, db, integrations) {
  route('ven/list', 'GET', null, req => rows(db, scheduleSql + ' WHERE s.ven_date>=? AND s.ven_date<?' + orderSchedule, monthBounds(req.query.monthYear || req.query.month)));
  route('ven/detail', 'GET', null, async req => {
    const id = integer(req.query.id), result = await one(db, scheduleSql + ' WHERE s.id=?', [id]);
    if (!result) fail(404, 'ไม่พบเวร');
    const history = await rows(db, changeSql + ' WHERE vc.s1_id=? OR vc.s2_id=? ORDER BY vc.id DESC', [id,id]);
    const latest = history.find(change => change.status === 1);
    return { ...result,ven_id: id,history,change_id: latest?.id || null,user1_name: latest?.user1_name || null,user2_name: latest?.user2_name || null };
  });
  route('user/ven_change_history', 'GET', null, req => rows(db, changeSql + ' WHERE vc.user1_id=? OR vc.user2_id=? ORDER BY vc.created_at DESC LIMIT 50', [req.user.id,req.user.id]));
  route('admin/ven/setting', req => ['ven_full','ven_name_list','list_venname','get_by_id'].includes(req.query.action) ? ['GET'] : ['POST'], [2,9], async req => {
    const body = req.body, action = req.query.action;
    if (['ven_full','ven_name_list'].includes(action)) return { success: true,data: await fullDuties(db) };
    if (action === 'list_venname') return { success: true,data: await rows(db, 'SELECT * FROM ven_name WHERE status=1 ORDER BY srt,id') };
    if (action === 'get_by_id') return one(db, 'SELECT * FROM ven_name WHERE id=?', [integer(req.query.id)]);
    if (['create_venname','update_venname'].includes(action)) {
      const values = { name: text(body.name, 'ชื่อเวร'),dn: text(body.dn, 'ช่วงเวลา'),srt: integer(body.srt ?? 999, 'ลำดับ', 0, 99999),name_full: text(body.name_full, 'ชื่อเต็ม', 5000, true) };
      // Match an existing configured shift period; prevents unparseable time intervals.
      if (!await one(db, 'SELECT id FROM ven_time WHERE CONCAT(name_th,\'(\',time_period,\')\')=?', [values.dn])) fail(400, 'ช่วงเวลาเวรไม่ถูกต้อง');
      if (body.id) await updateColumns(db, 'ven_name', 'id', integer(body.id), values, ['name','dn','srt','name_full']);
      else await rows(db, 'INSERT INTO ven_name (name,dn,srt,name_full,status) VALUES (?,?,?,?,1)', Object.values(values));
    } else if (action === 'delete_ven_name') {
      const id = integer(body.id);
      await transaction(db, async connection => { await rows(connection, 'UPDATE ven_name_sub SET status=0 WHERE ven_name_id=?', [id]); await rows(connection, 'UPDATE ven_name SET status=0 WHERE id=?', [id]); });
    } else if (['create_sub','update_sub'].includes(action)) {
      const values = { name: text(body.name, 'ชื่อหน้าที่'),price: integer(body.price ?? 0, 'ราคา', 0, 10000000),color: text(body.color, 'สี', 32),srt: integer(body.srt ?? 999, 'ลำดับ', 0, 99999) };
      if (!/^#[a-f0-9]{3,8}$/i.test(values.color)) fail(400, 'สีไม่ถูกต้อง');
      if (body.id) await updateColumns(db, 'ven_name_sub', 'id', integer(body.id), values, ['name','price','color','srt']);
      else {
        const parent = integer(body.ven_name_id);
        if (!await one(db, 'SELECT id FROM ven_name WHERE id=? AND status=1', [parent])) fail(400, 'ไม่พบเวรหลัก');
        await rows(db, 'INSERT INTO ven_name_sub (name,price,color,srt,ven_name_id,status) VALUES (?,?,?,?,?,1)', [...Object.values(values),parent]);
      }
    } else if (action === 'delete_sub_duty') await rows(db, 'UPDATE ven_name_sub SET status=0 WHERE id=?', [integer(body.id)]);
    else if (action === 'update_order') await transaction(db, async connection => { for (const item of array(body)) await rows(connection, 'UPDATE ven_name_sub SET srt=? WHERE id=?', [integer(item.srt,'ลำดับ',0,99999),integer(item.id)]); });
    else fail(404, 'ไม่พบคำสั่ง');
    return { success: true };
  });
  route('admin/ven_time', ['GET','POST','DELETE'], [2,9], async req => {
    const list = async () => rows(db, 'SELECT t.*,(SELECT COUNT(*) FROM ven_name n WHERE n.dn=CONCAT(t.name_th,\'(\',t.time_period,\')\')) AS used_count FROM ven_time t ORDER BY t.srt,t.id');
    if (req.method === 'GET') return list();
    await transaction(db, async connection => {
      const id = req.method === 'DELETE' ? integer(req.query.id) : req.body.id ? integer(req.body.id) : null;
      const existing = id ? await one(connection, 'SELECT * FROM ven_time WHERE id=? FOR UPDATE', [id]) : null;
      if (id && !existing) fail(404, 'ไม่พบช่วงเวลา');
      const used = existing && await one(connection, 'SELECT id FROM ven_name WHERE dn=? LIMIT 1', [`${existing.name_th}(${existing.time_period})`]);
      if (req.method === 'DELETE') { if (used) fail(409, 'มีการใช้ช่วงเวลานี้แล้ว'); await rows(connection, 'DELETE FROM ven_time WHERE id=?', [id]); return; }
      const name = text(req.body.name_th, 'ชื่อ', 50), period = text(req.body.time_period, 'เวลา', 50).replaceAll(':','.').replace(/\s/g,''), sort = integer(req.body.srt, 'ลำดับ', 1, 9999);
      if (/[()\r\n]/.test(name) || !/^(?:[01]\d|2[0-3])\.[0-5]\d-(?:[01]\d|2[0-3])\.[0-5]\d$/.test(period) || period.slice(0,5) === period.slice(6)) fail(400, 'ช่วงเวลาไม่ถูกต้อง');
      if (used && (name !== existing.name_th || period !== existing.time_period)) fail(409, 'เปลี่ยนได้เฉพาะลำดับ');
      if (await one(connection, 'SELECT id FROM ven_time WHERE name_th=? AND time_period=? AND id<>?', [name,period,id || 0])) fail(409, 'ช่วงเวลาซ้ำ');
      if (id) await rows(connection, 'UPDATE ven_time SET name_th=?,time_period=?,srt=? WHERE id=?', [name,period,sort,id]);
      else await rows(connection, 'INSERT INTO ven_time (name_th,time_period,srt) VALUES (?,?,?)', [name,period,sort]);
    }); return { success: true };
  });
  const eligible = req => rows(db, `SELECT vu.id AS vu_id,vu.order_num,vu.srt,u.id AS user_id,p.prefix_name,p.first_name,p.last_name,
    ${nameSql('p')} AS full_name FROM ven_user vu JOIN user u ON u.id=vu.user_id JOIN profile p ON p.user_id=u.id
    WHERE vu.ven_name_sub_id=? AND u.status=10 AND u.is_deleted=0 ORDER BY vu.srt,vu.order_num,vu.id`, [integer(req.query.sub_id)]);
  route('ven/eligible_users/get_by_sub', 'GET', null, eligible);
  route('admin/ven_user/get_by_sub', 'GET', [2,9], eligible);
  route('admin/ven_schedule/user_list_by_sub', 'GET', [2,9], eligible);
  route('admin/ven_schedule/ven_name_list', 'GET', [2,9], async () => ({ success: true,data: await fullDuties(db) }));
  route('admin/ven_user/add', 'POST', [2,9], async req => {
    const subId = integer(req.body.sub_id), userId = text(req.body.user_id, 'user_id', 36);
    await transaction(db, async connection => {
      if (!await one(connection, 'SELECT id FROM ven_name_sub WHERE id=? AND status=1 FOR UPDATE', [subId])) fail(404, 'ไม่พบหน้าที่');
      if (!await one(connection, 'SELECT id FROM user WHERE id=? AND status=10 AND is_deleted=0', [userId])) fail(400, 'ไม่พบผู้ใช้');
      if (await one(connection, 'SELECT id FROM ven_user WHERE ven_name_sub_id=? AND user_id=?', [subId,userId])) fail(409, 'มีรายชื่อนี้แล้ว');
      const last = await one(connection, 'SELECT COALESCE(MAX(srt),0) AS last FROM ven_user WHERE ven_name_sub_id=?', [subId]);
      await rows(connection, 'INSERT INTO ven_user (ven_name_sub_id,user_id,srt) VALUES (?,?,?)', [subId,userId,Number(last.last) + 1]);
    }); return { success: true };
  });
  route('admin/ven_user/remove', 'POST', [2,9], async req => { await rows(db, 'DELETE FROM ven_user WHERE id=?', [integer(req.body.vu_id)]); return { success: true }; });
  route('admin/ven_user/update_order', 'POST', [2,9], async req => { await transaction(db, connection => orderRows(connection,'ven_user','srt',req.body.ordered_ids)); return { success: true }; });
  route('admin/ven_com/list', 'GET', [2,9], () => rows(db, 'SELECT c.*,n.name AS ven_name_title FROM ven_com c LEFT JOIN ven_name n ON n.id=c.ven_name_id ORDER BY c.ven_month DESC,n.srt,c.com_date DESC'));
  for (const action of ['create','update']) route(`admin/ven_com/${action}`, 'POST', [2,9], async req => {
    const body = req.body, values = { com_num: text(body.com_num, 'เลขคำสั่ง'),com_date: date(body.com_date),ven_month: month(body.ven_month),ven_name_id: integer(body.ven_name_id),ven_com_days: text(body.ven_com_days ?? '', 'วันเวร', 255, true) };
    if (!await one(db, 'SELECT id FROM ven_name WHERE id=? AND status=1', [values.ven_name_id])) fail(400, 'ไม่พบประเภทเวร');
    if (action === 'create') await rows(db, 'INSERT INTO ven_com (com_num,com_date,ven_month,ven_name_id,ven_com_days,status) VALUES (?,?,?,?,?,0)', Object.values(values));
    else await updateColumns(db, 'ven_com', 'id', integer(body.id), values, Object.keys(values));
    return { success: true };
  });
  route('admin/ven_com/delete', 'DELETE', [2,9], async req => {
    const id = integer(req.query.id);
    await transaction(db, async connection => {
      await rows(connection, 'SELECT id FROM ven_com WHERE id=? FOR UPDATE', [id]);
      if (await one(connection, 'SELECT vc.id FROM ven_change vc JOIN ven_schedule s ON s.id=vc.s1_id OR s.id=vc.s2_id WHERE s.ven_com_id=? LIMIT 1', [id])) fail(409, 'มีประวัติเปลี่ยนเวร ไม่สามารถลบคำสั่ง');
      await rows(connection, 'DELETE FROM ven_schedule WHERE ven_com_id=?', [id]); await rows(connection, 'DELETE FROM ven_com WHERE id=?', [id]);
    }); return { success: true };
  });
  for (const action of ['toggle_status','update_status']) route(`admin/ven_com/${action}`, 'POST', [2,9], async req => {
    const status = flag(req.body.status), result = await rows(db, 'UPDATE ven_com SET status=? WHERE id=?', [status,integer(req.body.id)]);
    if (!result.affectedRows) fail(404, 'ไม่พบคำสั่ง');
    const sent = status === 1 ? await integrations.sendTelegram('📢 ตารางเวรประจำเดือนได้รับการยืนยันแล้ว', 'notify_confirmed').catch(() => false) : null;
    return { success: true,notification_sent: sent };
  });
  route('admin/ven_schedule/list_month', 'GET', [2,9], req => rows(db, scheduleSql + ' WHERE s.ven_date>=? AND s.ven_date<?' + orderSchedule, monthBounds(req.query.month)));
  route('admin/ven_schedule/add', 'POST', [2,9], async req => {
    const body = req.body, command = integer(body.com_id), sub = integer(body.sub_id), user = text(body.user_id, 'ผู้ใช้', 36), when = date(body.date);
    await transaction(db, async connection => {
      const com = await one(connection, 'SELECT * FROM ven_com WHERE id=? FOR UPDATE', [command]);
      if (!com || com.ven_month !== when.slice(0,7)) fail(400, 'วันที่ไม่ตรงเดือนคำสั่ง');
      if (!await one(connection, 'SELECT id FROM ven_name_sub WHERE id=? AND ven_name_id=? AND status=1', [sub,com.ven_name_id])) fail(400, 'หน้าที่ไม่ตรงคำสั่ง');
      if (!await one(connection, 'SELECT vu.id FROM ven_user vu JOIN user u ON u.id=vu.user_id WHERE vu.user_id=? AND vu.ven_name_sub_id=? AND u.status=10 AND u.is_deleted=0', [user,sub])) fail(400, 'ผู้ใช้ไม่มีสิทธิ์ในหน้าที่');
      if (await one(connection, 'SELECT id FROM ven_schedule WHERE ven_com_id=? AND ven_name_sub_id=? AND ven_date=? AND user_id=?', [command,sub,when,user])) fail(409, 'เวรซ้ำ');
      await rows(connection, 'INSERT INTO ven_schedule (ven_date,ven_com_id,ven_name_sub_id,user_id,status) VALUES (?,?,?,?,1)', [when,command,sub,user]);
    }); return { success: true };
  });
  route('admin/ven_schedule/remove', 'POST', [2,9], async req => {
    const id = integer(req.body.id);
    await transaction(db, async connection => {
      const schedule = await one(connection, 'SELECT id FROM ven_schedule WHERE id=? FOR UPDATE', [id]);
      if (!schedule) fail(404, 'ไม่พบเวร');
      if (await one(connection, 'SELECT id FROM ven_change WHERE s1_id=? OR s2_id=? LIMIT 1', [id,id])) fail(409, 'มีประวัติเปลี่ยนเวร ไม่สามารถลบ');
      await rows(connection, 'DELETE FROM ven_schedule WHERE id=?', [id]);
    }); return { success: true };
  });
  route('admin/ven_schedule/sync_google', 'POST', [2,9], req => integrations.syncGoogle(month(req.body.month)));
  route('admin/ven_schedule/move','POST',[2,9],async req=>{
    const id=integer(req.body.id),when=date(req.body.date);
    await transaction(db,async connection=>{
      const initial=await one(connection,'SELECT ven_com_id FROM ven_schedule WHERE id=?',[id]);
      if(!initial)fail(404,'ไม่พบเวร');
      const command=await one(connection,'SELECT ven_month FROM ven_com WHERE id=? FOR UPDATE',[initial.ven_com_id]);
      const schedule=await one(connection,'SELECT * FROM ven_schedule WHERE id=? FOR UPDATE',[id]);
      if(!schedule||schedule.ven_com_id!==initial.ven_com_id)fail(409,'เวรเปลี่ยนแปลงแล้ว');
      if(!command||command.ven_month!==when.slice(0,7))fail(400,'วันที่ไม่ตรงเดือนคำสั่ง');
      if(await one(connection,'SELECT id FROM ven_change WHERE s1_id=? OR s2_id=? LIMIT 1',[id,id]))fail(409,'มีประวัติเปลี่ยนเวร ไม่สามารถย้ายวันที่');
      if(await one(connection,'SELECT id FROM ven_schedule WHERE ven_com_id=? AND ven_name_sub_id=? AND ven_date=? AND user_id=? AND id<>?',[schedule.ven_com_id,schedule.ven_name_sub_id,when,schedule.user_id,id]))fail(409,'เวรซ้ำ');
      await rows(connection,'UPDATE ven_schedule SET ven_date=?,google_event_id=NULL WHERE id=?',[when,id]);
    });return {success:true};
  });
  route('report/monthly', 'GET', null, req => rows(db, 'SELECT c.id,c.com_num AS ven_com_num,c.com_date AS ven_com_date,n.name AS ven_com_name,n.srt FROM ven_com c LEFT JOIN ven_name n ON n.id=c.ven_name_id WHERE c.ven_month=? ORDER BY n.srt,c.com_num', [month(req.query.monthYear || (req.query.year ? `${integer(req.query.year,'ปี',1900,2099)}-${String(integer(req.query.month,'เดือน',1,12)).padStart(2,'0')}` : req.query.month))]));
  route('report/schedule-details', 'GET', null, async req => {
    const result = await rows(db, scheduleSql + ' WHERE s.ven_com_id=?' + orderSchedule, [integer(req.query.command_id)]), grouped = new Map();
    for (const row of result) {
      if (!grouped.has(row.ven_date)) grouped.set(row.ven_date, { ven_date: row.ven_date,staff_list: [] });
      grouped.get(row.ven_date).staff_list.push({ id: row.id,full_name: row.full_name,position: row.position,ven_name: row.ven_name,sub_name: row.sub_name,status: row.status });
    } return [...grouped.values()];
  });
  route('report/personal-schedule', 'GET', [2,9], req => rows(db, scheduleSql.replace('n.name AS ven_name,','n.name AS ven_com_name,n.name AS ven_name,').replace('c.com_num,','c.com_num AS ven_com_num,c.com_num,') + ' WHERE s.user_id=? AND MONTH(s.ven_date)=? AND YEAR(s.ven_date)=? AND s.status IN (1,2)' + orderSchedule, [text(req.query.user_id,'ผู้ใช้',36),integer(req.query.month,'เดือน',1,12),integer(req.query.year,'ปี',1900,2099)]));
  route('get_commands', 'GET', [3,9], async req => ({ status: 'success',data: await rows(db, 'SELECT c.id,n.name,c.com_date,c.com_num FROM ven_com c LEFT JOIN ven_name n ON n.id=c.ven_name_id WHERE c.ven_month=? ORDER BY c.com_date', [month(req.query.month)]) }));
  route('finance/report', 'GET', [3,9], async req => {
    const selectedMonth = month(req.query.month), bounds = monthBounds(selectedMonth), commandId = integer(req.query.command_id);
    const holidays = await rows(db, 'SELECT DISTINCT DAY(s.ven_date) AS h_day FROM ven_schedule s JOIN ven_com c ON c.id=s.ven_com_id JOIN ven_name n ON n.id=c.ven_name_id WHERE s.ven_date>=? AND s.ven_date<? AND n.dn LIKE \'กลางวัน%\' ORDER BY h_day', bounds);
    const report = await rows(db, `SELECT p.prefix_name,p.first_name,p.last_name,p.position,COUNT(s.id) AS total_days,sub.price AS rate_per_day,
      GROUP_CONCAT(DAY(s.ven_date) ORDER BY s.ven_date SEPARATOR ', ') AS work_dates,'' AS remark FROM ven_schedule s JOIN profile p ON p.user_id=s.user_id
      JOIN ven_name_sub sub ON sub.id=s.ven_name_sub_id WHERE s.ven_com_id=? AND s.ven_date>=? AND s.ven_date<?
      GROUP BY p.user_id,p.prefix_name,p.first_name,p.last_name,p.position,p.srt,sub.price ORDER BY p.srt`, [commandId,...bounds]);
    const total = new Date(Date.UTC(Number(selectedMonth.slice(0,4)),Number(selectedMonth.slice(5)),0)).getUTCDate();
    return { status: 'success',data: { month_info: { total_days: total,holidays: holidays.map(row => row.h_day) },report_list: report } };
  });
}
