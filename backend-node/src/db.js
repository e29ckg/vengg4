import mysql from 'mysql2/promise';
export const createDatabase = config => mysql.createPool(config.db);
export async function rows(db, sql, params = []) { const [result] = await db.execute(sql, params); return result; }
export async function one(db, sql, params = []) { return (await rows(db, sql, params))[0] || null; }
export async function transaction(db, task) {
  const connection = await db.getConnection();
  try { await connection.beginTransaction(); const result = await task(connection); await connection.commit(); return result; }
  catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
export async function audit(db, user, action, module, description, ip) {
  // Deliberately never log request bodies, passwords, tokens, TOTP secrets or recovery codes.
  await rows(db, 'INSERT INTO system_logs (user_id,action,module,description,ip_address) VALUES (?,?,?,?,?)',
    [user?.id || null, action, module, description, ip || null]);
}
