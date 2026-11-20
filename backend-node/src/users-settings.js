import { randomUUID } from 'node:crypto';
import { one, rows, transaction, audit } from './db.js';
import { text, integer, flag, array, json, password, fail, fullName } from './validation.js';
import { hashPassword } from './security.js';

const profileFields = ['prefix_name','first_name','last_name','position','department','phone','bank_account','bank_comment'];
const profileValues = body => profileFields.map(key => text(body[key], key, ({ prefix_name:25,bank_account:100,bank_comment:200 })[key] || 255, key !== 'first_name'));
const permittedRole = value => { const role = integer(value, 'role'); if (![1,2,3,9].includes(role)) fail(400, 'สิทธิ์ไม่ถูกต้อง'); return role; };
async function revoke(db, id) {
  await rows(db, 'UPDATE user SET auth_key=NULL WHERE id=?', [id]);
  await rows(db, 'DELETE FROM node_sessions WHERE user_id=?', [id]);
  await rows(db, 'DELETE FROM node_challenges WHERE user_id=?', [id]);
}
async function preserveAdmin(db, id, role, status, deleted) {
  const admins = await rows(db, 'SELECT id FROM user WHERE role=9 AND status=10 AND is_deleted=0 ORDER BY id FOR UPDATE');
  if (admins.length === 1 && admins[0].id === id && (role !== 9 || status !== 10 || deleted)) fail(409, 'ไม่สามารถปิดหรือลบผู้ดูแลคนสุดท้าย');
}
export async function updateColumns(db, table, idColumn, id, values, whitelist) {
  const keys = Object.keys(values).filter(key => whitelist.includes(key));
  if (!keys.length) fail(400, 'ไม่มีข้อมูลที่แก้ไขได้');
  // Table, column names and whitelist are internal constants, never request-supplied.
  return rows(db, `UPDATE \`${table}\` SET ${keys.map(key => `\`${key}\`=?`).join(',')} WHERE \`${idColumn}\`=?`, [...keys.map(key => values[key]), id]);
}
export async function orderRows(db, table, column, identifiers, idColumn = 'id') {
  const ids = array(identifiers).map(value => idColumn === 'user_id' ? text(value, 'user_id', 36) : integer(value));
  if (new Set(ids).size !== ids.length) fail(400, 'รายการซ้ำ');
  for (let i = 0; i < ids.length; i++) await rows(db, `UPDATE \`${table}\` SET \`${column}\`=? WHERE \`${idColumn}\`=?`, [i + 1, ids[i]]);
}

export function registerUsersSettings(route, db) {
  route('user/profile', 'GET', null, req => one(db, 'SELECT avatar,prefix_name,first_name,last_name,position,department,phone,bank_account,bank_comment FROM profile WHERE user_id=?', [req.user.id]));
  route('user/profile/update', ['POST','PUT'], null, async req => {
    const parsed = profileValues(req.body), values = Object.fromEntries(profileFields.map((key, i) => [key,parsed[i]]));
    await updateColumns(db, 'profile', 'user_id', req.user.id, values, profileFields); return { success: true };
  });
  async function listUsers(privateData, activeOnly = false) {
    const fields = privateData ? ',p.phone,p.bank_account,p.bank_comment,EXISTS(SELECT 1 FROM node_mfa m WHERE m.user_id=u.id) AS mfa_enabled,EXISTS(SELECT 1 FROM node_mfa_resets r WHERE r.user_id=u.id) AS mfa_reset_pending' : '';
    const result = await rows(db, `SELECT u.id,u.username,u.role,u.status,p.avatar,p.prefix_name,p.first_name,p.last_name,p.position,p.srt,p.department,p.st${fields}
      FROM user u LEFT JOIN profile p ON p.user_id=u.id WHERE u.is_deleted=0 ${activeOnly ? 'AND u.status=10' : ''} ORDER BY p.srt,u.id`);
    return result.map(row => ({ ...row, full_name: fullName(row) || '-' }));
  }
  route('admin/user/list', 'GET', [9], () => listUsers(true));
  route('admin/ven_user/allUsers', 'GET', [2,9], () => listUsers(false, true));
  route('users/list', 'GET', [2,9], async () => (await listUsers(false)).map(({ id,full_name,position,department,status }) => ({ id,full_name,position,department,status })));
  route('admin/user/create', 'POST', [9], async req => {
    const body = req.body, username = text(body.username, 'username', 128), digest = await hashPassword(password(body.password));
    const role = permittedRole(body.role || 1), status = body.status === undefined ? 10 : integer(body.status, 'status', 0, 10);
    if (![0,10].includes(status)) fail(400, 'สถานะไม่ถูกต้อง');
    const values = profileValues(body), id = randomUUID();
    await transaction(db, async connection => {
      await rows(connection, 'INSERT INTO user (id,username,password_hash,role,status,created_at) VALUES (?,?,?,?,?,NOW())', [id,username,digest,role,status]);
      await rows(connection, `INSERT INTO profile (user_id,${profileFields.join(',')},srt) VALUES (?,?,?,?,?,?,?,?,?,?)`, [id,...values,integer(body.srt || 999, 'srt', 0, 99999)]);
      await audit(connection, req.user, 'CREATE', 'USER', `Created user ${id}`, req.ip);
    }); return { success: true, id, message: 'เพิ่มผู้ใช้แล้ว' };
  });
  for (const action of ['status','update','delete']) route(`admin/user/${action}`, 'POST', [9], async req => {
    const id = text(req.body.id, 'id', 36);
    const digest = req.body.password ? await hashPassword(password(req.body.password)) : null;
    await transaction(db, async connection => {
      // Always acquire administrator locks before the individual user lock.
      const current = await one(connection, 'SELECT id,role,status,is_deleted FROM user WHERE id=?', [id]);
      if (!current || current.is_deleted) fail(404, 'ไม่พบผู้ใช้');
      const role = action === 'update' ? permittedRole(req.body.role ?? current.role) : Number(current.role);
      const status = action === 'status' || action === 'update' ? integer(req.body.status ?? current.status, 'status', 0, 10) : Number(current.status);
      if (![0,10].includes(status)) fail(400, 'สถานะไม่ถูกต้อง');
      await preserveAdmin(connection, id, role, status, action === 'delete');
      await rows(connection, 'SELECT id FROM user WHERE id=? FOR UPDATE', [id]);
      await rows(connection, 'UPDATE user SET role=?,status=?,is_deleted=?,updated_at=NOW() WHERE id=?', [role,status,action === 'delete' ? 1 : 0,id]);
      if (action === 'update') {
        const values = Object.fromEntries(profileFields.map((key, i) => [key, profileValues(req.body)[i]]));
        if (req.body.srt !== undefined) values.srt = integer(req.body.srt, 'srt', 0, 99999);
        await updateColumns(connection, 'profile', 'user_id', id, values, [...profileFields,'srt']);
        if (digest) await rows(connection, 'UPDATE user SET password_hash=? WHERE id=?', [digest,id]);
      }
      await revoke(connection, id);
      await audit(connection, req.user, action.toUpperCase(), 'USER', `Changed user ${id}`, req.ip);
    }); return { success: true };
  });
  route('admin/users/update_order', 'POST', [9], async req => {
    const items = array(req.body);
    await transaction(db, async connection => { for (const item of items) await rows(connection, 'UPDATE profile SET srt=? WHERE user_id=?', [integer(item.srt, 'srt', 0, 99999),text(item.id, 'id', 36)]); });
    return { success: true };
  });
  const getOptions = async connection => json((await one(connection, 'SELECT user_options FROM system_settings WHERE id=1'))?.user_options, { prefixes: [],positions: [],departments: [] });
  route('admin/options/get', 'GET', null, () => getOptions(db));
  for (const action of ['add','delete']) route(`admin/options/${action}`, action === 'delete' ? ['POST','DELETE'] : 'POST', [9], async req => {
    const types = { prefix: 'prefixes',position: 'positions',department: 'departments' };
    const key = typeof req.body.type === 'string' && Object.hasOwn(types,req.body.type) ? types[req.body.type] : null;
    if (!key) fail(400, 'ประเภทไม่ถูกต้อง');
    const value = text(req.body.value, 'ตัวเลือก', 255);
    await transaction(db, async connection => {
      await rows(connection, 'SELECT id FROM system_settings WHERE id=1 FOR UPDATE');
      const options = await getOptions(connection), items = Array.isArray(options[key]) ? options[key] : [];
      if (action === 'add' && items.includes(value)) fail(409, 'มีข้อมูลนี้อยู่แล้ว');
      if (items.length >= 1000 && action === 'add') fail(400, 'ตัวเลือกมากเกินไป');
      options[key] = action === 'add' ? [...items,value] : items.filter(item => item !== value);
      await rows(connection, 'UPDATE system_settings SET user_options=? WHERE id=1', [JSON.stringify(options)]);
    }); return { success: true };
  });
  const settingKeys = ['system_name','allow_swap','allow_retroactive_swap','check_24h_consecutive','maintenance_mode','compact_schedule_view','advance_swap_days'];
  const settingValue = (key, value) => key === 'system_name' ? text(value, key) : key === 'advance_swap_days' ? integer(value, key, 0, 365) : typeof value === 'boolean' ? Number(value) : flag(value);
  for (const name of ['system_settings','admin/system_settings']) route(name, name.startsWith('admin/') ? ['GET','POST'] : 'GET', req => req.method === 'POST' || name.startsWith('admin/') ? [9] : null, async req => {
    if (req.method === 'GET') return one(db, 'SELECT * FROM system_settings WHERE id=1');
    const values = Object.fromEntries(settingKeys.filter(key => Object.hasOwn(req.body, key)).map(key => [key,settingValue(key,req.body[key])]));
    await updateColumns(db, 'system_settings', 'id', 1, values, settingKeys); return { success: true };
  });
  route('admin/settings/update_toggle', 'POST', [9], async req => {
    const key = req.body.setting_key; if (!settingKeys.includes(key)) fail(400, 'ค่าตั้งค่าไม่ถูกต้อง');
    await updateColumns(db, 'system_settings', 'id', 1, { [key]: settingValue(key,req.body.setting_value) }, settingKeys); return { success: true };
  });
  route('admin/agency_settings', ['GET','POST'], req => req.method === 'GET' ? null : [9], async req => {
    if (req.method === 'GET') {
      const setting = await one(db, 'SELECT * FROM agency_settings WHERE id=1') || {};
      return { ...setting, directors: json(setting.directors), admins: json(setting.admins), finances: json(setting.finances) };
    }
    const values = ['directors','admins','finances'].map(key => JSON.stringify(array(req.body[key] || [], 100)));
    await rows(db, 'INSERT INTO agency_settings (id,agency_name,directors,admins,finances) VALUES (1,?,?,?,?) ON DUPLICATE KEY UPDATE agency_name=VALUES(agency_name),directors=VALUES(directors),admins=VALUES(admins),finances=VALUES(finances)', [text(req.body.agency_name, 'ชื่อหน่วยงาน', 255, true),...values]);
    return { success: true };
  });
  route('admin/logs/get', 'GET', [9], async () => ({ success: true, data: await rows(db, `SELECT l.id,l.user_id,l.action,l.module,l.description,l.created_at,
    CONCAT_WS(' ',p.prefix_name,p.first_name,p.last_name) AS full_name FROM system_logs l LEFT JOIN profile p ON p.user_id=l.user_id ORDER BY l.created_at DESC LIMIT 500`) }));
}
