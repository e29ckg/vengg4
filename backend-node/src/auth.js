import QRCode from 'qrcode';
import { one, rows, transaction, audit } from './db.js';
import { cookieNames, cookieOptions, cookies, randomToken, hash, verifyPassword, hashPassword,
  newTotp, encryptSecret, decryptSecret, totpCounter, recoveryCodes, recoveryHash, limit } from './security.js';
import { fail, text, password, fullName } from './validation.js';

export class AuthService {
  constructor(db, config) { this.db = db; this.config = config; this.names = cookieNames(config); }
  clear(res) { for (const name of [this.names.session, this.names.challenge]) res.clearCookie(name, cookieOptions(this.config)); }
  async session(db, user, verified) {
    await rows(db,'SELECT id FROM user WHERE id=? FOR UPDATE',[user.id]);
    const token = randomToken();
    await rows(db, 'DELETE FROM node_sessions WHERE user_id=?', [user.id]);
    await rows(db, `INSERT INTO node_sessions (token_hash,user_id,password_stamp,mfa_verified,expires_at)
      VALUES (?,?,?,?,DATE_ADD(NOW(),INTERVAL 8 HOUR))`, [hash(token), user.id, hash(user.password_hash), verified ? 1 : 0]);
    return token;
  }
  async response(user, token, res, db = this.db) {
    const profile = await one(db, 'SELECT prefix_name,first_name,last_name,avatar FROM profile WHERE user_id=?', [user.id]);
    res.cookie(this.names.session, token, { ...cookieOptions(this.config), maxAge: 8 * 3600000 });
    res.clearCookie(this.names.challenge, cookieOptions(this.config));
    return { authenticated: true, user: { id: user.id, username: user.username, role: Number(user.role), fullname: fullName(profile || {}), avatar: profile?.avatar || null } };
  }
  async challenge(user, purpose, req, res, sessionHash = null) {
    const token = randomToken(), totp = purpose === 'login' ? null : newTotp(null, user.username);
    const secret = totp?.secret.base32;
    await transaction(this.db, async db => {
      await rows(db,'SELECT id FROM user WHERE id=? FOR UPDATE',[user.id]);
      await rows(db, 'DELETE FROM node_challenges WHERE user_id=? AND purpose=?', [user.id, purpose]);
      await rows(db, `INSERT INTO node_challenges (token_hash,user_id,purpose,password_stamp,session_hash,secret_encrypted,expires_at)
        VALUES (?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 5 MINUTE))`,
      [hash(token), user.id, purpose, hash(user.password_hash), sessionHash, secret ? encryptSecret(secret, this.config.mfaKey, user.id) : null]);
    });
    res.cookie(this.names.challenge, token, { ...cookieOptions(this.config), maxAge: 300000 });
    return { mfa_required: true, enrollment_required: purpose !== 'login', expires_in: 300,
      ...(totp ? { secret, otp_uri: totp.toString(), qr_code: await QRCode.toDataURL(totp.toString(), { errorCorrectionLevel: 'M' }) } : {}) };
  }
  async login(req, res) {
    const username = text(req.body.username, 'ชื่อผู้ใช้', 128);
    const supplied = req.body.password;
    if (typeof supplied !== 'string' || !supplied || Buffer.byteLength(supplied) > 72) fail(400, 'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง');
    await limit(this.db, `login:ip:${req.ip}`, 60);
    const user = await one(this.db, 'SELECT id,username,role,status,is_deleted,password_hash FROM user WHERE username=? LIMIT 1', [username]);
    await limit(this.db, `login:user:${user?.id || `unknown:${req.ip}`}`, 8);
    const verified = await verifyPassword(supplied, user?.password_hash);
    if (!user || !verified || Number(user.status) !== 10 || user.is_deleted) {
      await audit(this.db, null, 'LOGIN_FAILED', 'AUTH', 'Invalid login', req.ip);
      fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    const settings = await one(this.db, 'SELECT maintenance_mode FROM system_settings WHERE id=1');
    if (settings?.maintenance_mode && Number(user.role) !== 9) fail(403, 'ระบบกำลังปิดปรับปรุง', 'MAINTENANCE');
    this.clear(res);
    const mfa = await one(this.db, 'SELECT user_id FROM node_mfa WHERE user_id=?', [user.id]);
    const reset = await one(this.db, 'SELECT user_id FROM node_mfa_resets WHERE user_id=?', [user.id]);
    if (mfa || reset || Number(user.role) === 9) return this.challenge(user, mfa ? 'login' : 'enroll', req, res);
    const token = await transaction(this.db, db => this.session(db, user, false));
    await audit(this.db, user, 'LOGIN', 'AUTH', 'Password login', req.ip);
    return this.response(user, token, res);
  }
  async saveRecovery(db, userId) {
    const codes = recoveryCodes();
    await rows(db, 'DELETE FROM node_mfa_recovery WHERE user_id=?', [userId]);
    for (const code of codes) await rows(db, 'INSERT INTO node_mfa_recovery (user_id,code_hash) VALUES (?,?)', [userId, recoveryHash(code)]);
    return codes;
  }
  async proof(db, userId, code, allowRecovery = true) {
    const mfa = await one(db, 'SELECT * FROM node_mfa WHERE user_id=? FOR UPDATE', [userId]);
    if (!mfa) return false;
    const counter = totpCounter(decryptSecret(mfa.secret_encrypted, this.config.mfaKey, userId), code, Date.now(), mfa.last_counter);
    if (counter !== null) {
      await rows(db, 'UPDATE node_mfa SET last_counter=? WHERE user_id=?', [counter, userId]);
      return true;
    }
    if (allowRecovery && typeof code === 'string' && /^[a-f0-9]{5}(?:-[a-f0-9]{5}){3}$/i.test(code)) {
      const result = await rows(db, 'DELETE FROM node_mfa_recovery WHERE user_id=? AND code_hash=?', [userId, recoveryHash(code)]);
      return result.affectedRows === 1;
    }
    return false;
  }
  async verify(req, res, confirmation) {
    const raw = cookies(req)[this.names.challenge];
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) fail(401, 'กรุณาเข้าสู่ระบบใหม่');
    await limit(this.db, `mfa:ip:${req.ip}`, 40);
    const outcome = await transaction(this.db, async db => {
      const initial = await one(db,'SELECT user_id FROM node_challenges WHERE token_hash=?',[hash(raw)]);
      if (!initial) return null;
      const user = await one(db, 'SELECT * FROM user WHERE id=? AND status=10 AND is_deleted=0 FOR UPDATE', [initial.user_id]);
      const challenge = await one(db, 'SELECT * FROM node_challenges WHERE token_hash=? AND expires_at>NOW() FOR UPDATE', [hash(raw)]);
      if (!challenge || challenge.attempts >= 5) return null;
      if (!user || challenge.password_stamp !== hash(user.password_hash) || confirmation !== (challenge.purpose !== 'login')) return null;
      if (challenge.purpose === 'setup' && hash(cookies(req)[this.names.session] || '') !== challenge.session_hash) return null;
      await rows(db, 'UPDATE node_challenges SET attempts=attempts+1 WHERE token_hash=?', [hash(raw)]);
      let codes;
      if (challenge.purpose === 'login') {
        if (!await this.proof(db, user.id, req.body.code)) return null;
      } else {
        const counter = totpCounter(decryptSecret(challenge.secret_encrypted, this.config.mfaKey, user.id), req.body.code);
        if (counter === null || await one(db, 'SELECT user_id FROM node_mfa WHERE user_id=?', [user.id])) return null;
        await rows(db, 'INSERT INTO node_mfa (user_id,secret_encrypted,last_counter) VALUES (?,?,?)', [user.id, challenge.secret_encrypted, counter]);
        codes = await this.saveRecovery(db, user.id);
        await rows(db, 'DELETE FROM node_mfa_resets WHERE user_id=?', [user.id]);
      }
      await rows(db, 'DELETE FROM node_challenges WHERE user_id=?', [user.id]);
      const token = await this.session(db, user, true);
      await audit(db, user, 'MFA_LOGIN', 'AUTH', codes ? 'MFA enabled' : 'MFA login', req.ip);
      return { user, token, codes };
    });
    if (!outcome) fail(401, 'รหัส MFA ไม่ถูกต้อง ถูกใช้แล้ว หรือหมดอายุ');
    return { ...await this.response(outcome.user, outcome.token, res), ...(outcome.codes ? { recovery_codes: outcome.codes } : {}) };
  }
  async setup(req, res) {
    await limit(this.db, `mfa:setup:${req.user.id}`, 5);
    if (!await verifyPassword(req.body.password, req.user.password_hash)) fail(401, 'รหัสผ่านไม่ถูกต้อง');
    if (await one(this.db, 'SELECT user_id FROM node_mfa WHERE user_id=?', [req.user.id])) fail(409, 'เปิด MFA อยู่แล้ว');
    return this.challenge(req.user, 'setup', req, res, req.user.token_hash);
  }
  async changeMfa(req, res, disable) {
    if (disable && Number(req.user.role) === 9) fail(403, 'ผู้ดูแลระบบต้องเปิด MFA');
    await limit(this.db, `mfa:change:${req.user.id}`, 10);
    if (!await verifyPassword(req.body.password, req.user.password_hash)) fail(401, 'รหัสผ่านไม่ถูกต้อง');
    const result = await transaction(this.db, async db => {
      const current=await one(db,'SELECT id,role,password_hash FROM user WHERE id=? AND status=10 AND is_deleted=0 FOR UPDATE',[req.user.id]);
      if(!current||current.password_hash!==req.user.password_hash)fail(401,'บัญชีเปลี่ยนแปลงแล้ว กรุณาเข้าสู่ระบบใหม่','AUTH_REQUIRED');
      if(disable&&Number(current.role)===9)fail(403,'ผู้ดูแลระบบต้องเปิด MFA');
      if (!await this.proof(db, req.user.id, req.body.code)) return null;
      await rows(db, 'DELETE FROM node_challenges WHERE user_id=?', [req.user.id]);
      if (disable) {
        await rows(db, 'DELETE FROM node_mfa WHERE user_id=?', [req.user.id]);
        await rows(db, 'DELETE FROM node_mfa_recovery WHERE user_id=?', [req.user.id]);
        await rows(db, 'DELETE FROM node_sessions WHERE user_id=?', [req.user.id]);
        return { success: true };
      }
      await rows(db, 'DELETE FROM node_sessions WHERE user_id=? AND token_hash<>?', [req.user.id, req.user.token_hash]);
      return { success: true, recovery_codes: await this.saveRecovery(db, req.user.id) };
    });
    if (!result) fail(401, 'รหัส MFA ไม่ถูกต้องหรือถูกใช้แล้ว');
    await audit(this.db, req.user, disable ? 'MFA_DISABLED' : 'RECOVERY_ROTATED', 'AUTH', 'MFA settings changed', req.ip);
    if (disable) this.clear(res);
    return result;
  }
  async resetUserMfa(req) {
    if (Number(req.user.role) !== 9) fail(403, 'เฉพาะผู้ดูแลระบบ');
    const targetId = text(req.body.user_id, 'user_id', 36);
    if (targetId === req.user.id) fail(403, 'ไม่สามารถรีเซ็ต MFA ของตัวเองผ่านหน้าจัดการสมาชิก');
    await limit(this.db, `mfa:admin-reset:${req.user.id}`, 10);
    if (!await verifyPassword(req.body.password, req.user.password_hash)) fail(401, 'รหัสผ่านผู้ดูแลไม่ถูกต้อง');
    const result = await transaction(this.db, async db => {
      // Match user administration lock order, then serialize reset with target logins.
      await rows(db, 'SELECT id FROM user WHERE role=9 AND status=10 AND is_deleted=0 ORDER BY id FOR UPDATE');
      const actor = await one(db, 'SELECT id,role,password_hash FROM user WHERE id=? AND status=10 AND is_deleted=0 FOR UPDATE', [req.user.id]);
      if (!actor || Number(actor.role) !== 9 || actor.password_hash !== req.user.password_hash) fail(401, 'กรุณาเข้าสู่ระบบใหม่', 'AUTH_REQUIRED');
      const session = await one(db, 'SELECT token_hash FROM node_sessions WHERE token_hash=? AND user_id=? AND mfa_verified=1 AND expires_at>NOW() FOR UPDATE', [req.user.token_hash, actor.id]);
      if (!session) fail(401, 'กรุณาเข้าสู่ระบบใหม่', 'AUTH_REQUIRED');
      const target = await one(db, 'SELECT id FROM user WHERE id=? AND is_deleted=0 FOR UPDATE', [targetId]);
      if (!target) fail(404, 'ไม่พบผู้ใช้');
      if (!await one(db, 'SELECT user_id FROM node_mfa WHERE user_id=?', [targetId])) fail(409, 'ผู้ใช้ยังไม่ได้เปิด MFA หรือกำลังรอตั้งค่าใหม่');
      if (!await this.proof(db, actor.id, req.body.code)) return null;
      for (const table of ['node_mfa','node_mfa_recovery','node_sessions','node_challenges']) {
        await rows(db, `DELETE FROM ${table} WHERE user_id=?`, [targetId]);
      }
      await rows(db, 'INSERT INTO node_mfa_resets (user_id,requested_by) VALUES (?,?) ON DUPLICATE KEY UPDATE requested_by=VALUES(requested_by),created_at=NOW()', [targetId, actor.id]);
      await rows(db, 'UPDATE user SET auth_key=NULL WHERE id=?', [targetId]);
      await audit(db, actor, 'MFA_RESET', 'AUTH', `Reset MFA for user ${targetId}`, req.ip);
      return { success: true, enrollment_required: true };
    });
    if (!result) fail(401, 'รหัส MFA ผู้ดูแลไม่ถูกต้องหรือถูกใช้แล้ว');
    return result;
  }
  async changePassword(req, res) {
    await limit(this.db, `password:${req.user.id}`, 10);
    const newPassword = password(req.body.new_password);
    if (!await verifyPassword(req.body.old_password, req.user.password_hash)) fail(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    const digest = await hashPassword(newPassword);
    await transaction(this.db, async db => {
      const result = await rows(db, 'UPDATE user SET password_hash=?,auth_key=NULL WHERE id=? AND password_hash=?', [digest, req.user.id, req.user.password_hash]);
      if (result.affectedRows !== 1) fail(409, 'บัญชีมีการเปลี่ยนแปลง กรุณาเข้าสู่ระบบใหม่');
      await rows(db, 'DELETE FROM node_sessions WHERE user_id=?', [req.user.id]);
      await rows(db, 'DELETE FROM node_challenges WHERE user_id=?', [req.user.id]);
    });
    this.clear(res); return { success: true, message: 'เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบใหม่' };
  }
  async status(req) {
    const enabled = !!await one(this.db, 'SELECT user_id FROM node_mfa WHERE user_id=?', [req.user.id]);
    const remaining = await one(this.db, 'SELECT COUNT(*) AS total FROM node_mfa_recovery WHERE user_id=?', [req.user.id]);
    return { enabled, required: Number(req.user.role) === 9, recovery_remaining: Number(remaining.total) };
  }
  async logout(req, res) {
    await transaction(this.db,async db => {
      await rows(db,'SELECT id FROM user WHERE id=? FOR UPDATE',[req.user.id]);
      await rows(db, 'DELETE FROM node_sessions WHERE token_hash=?', [req.user.token_hash]);
      await rows(db, 'DELETE FROM node_challenges WHERE user_id=?', [req.user.id]);
    });
    this.clear(res); return { success: true };
  }
}
