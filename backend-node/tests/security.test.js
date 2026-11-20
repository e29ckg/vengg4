import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { root } from '../src/config.js';
import { createApp } from '../src/app.js';
import { newTotp,totpCounter,encryptSecret,decryptSecret,hashPassword,verifyPassword,recoveryCodes,recoveryHash,issueCsrf,enforceCsrf } from '../src/security.js';
import { date,month,password } from '../src/validation.js';
import { validateDocx } from '../src/files.js';
import { validateCredentials } from '../src/integrations.js';
import yazl from 'yazl';

test('TOTP matches RFC 6238 SHA1 vectors, rejects replay and wrong format', () => {
  const otp = newTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const [seconds,lastSix] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']]) {
    assert.equal(otp.generate({ timestamp: seconds * 1000 }),lastSix);
    const counter = totpCounter(otp.secret.base32,lastSix,seconds * 1000);
    assert.equal(counter,Math.floor(seconds / 30));
    assert.equal(totpCounter(otp.secret.base32,lastSix,seconds * 1000,counter),null);
  }
  assert.equal(totpCounter(otp.secret.base32,123456),null);
});
test('MFA secrets are authenticated encrypted and bound to a user', () => {
  const key = randomBytes(32), sealed = encryptSecret('BASE32-SECRET',key,'one');
  assert.ok(!sealed.includes('BASE32-SECRET'));
  assert.equal(decryptSecret(sealed,key,'one'),'BASE32-SECRET');
  assert.throws(() => decryptSecret(sealed,key,'two'));
  assert.throws(() => decryptSecret(sealed,randomBytes(32),'one'));
});
test('bcrypt hashes accept existing PHP $2y$ accounts', async () => {
  const digest = await hashPassword('test-password-12345');
  assert.equal(await verifyPassword('test-password-12345',digest.replace(/^\$2b\$/,'$2y$')),true);
  assert.equal(await verifyPassword('wrong-password',digest),false);
  assert.equal(await verifyPassword('x'.repeat(73),digest),false);
});
test('CSRF requires signed matching header and cookie, not a bearer token', () => {
  const config = { secure: false,sessionKey: randomBytes(32) }; let cookie;
  const issued = issueCsrf({ headers: {} },{ cookie(name,value){cookie=`${name}=${value}`;} },config);
  assert.doesNotThrow(() => enforceCsrf({ method: 'POST',headers: { cookie },get: () => issued.csrf_token },config));
  assert.throws(() => enforceCsrf({ method: 'POST',headers: { cookie },get: () => 'forged' },config),/CSRF/);
  const forged = 'x'.repeat(43)+'.'+'y'.repeat(43);
  assert.throws(() => enforceCsrf({ method: 'POST',headers: { cookie: `vengg4_csrf=${forged}` },get: () => forged },config),/CSRF/);
});
test('recovery codes have unique high-entropy hashes', () => {
  const codes = recoveryCodes(); assert.equal(new Set(codes).size,10);
  for (const code of codes) { assert.match(code,/^[a-f0-9]{5}(-[a-f0-9]{5}){3}$/); assert.equal(recoveryHash(code),recoveryHash(code.toUpperCase())); }
});
test('input validation rejects SQL-ish IDs, invalid dates and oversized passwords', () => {
  assert.throws(() => month("2026-01' OR 1=1"));
  for (const value of ['2026-02-30','2026-99-99','not-a-date']) assert.throws(() => date(value));
  assert.throws(() => password('ส'.repeat(25)));
  assert.equal(date('2028-02-29'),'2028-02-29');
});
test('all supported routes have a native Node implementation and method policy', async () => {
  const legacy = JSON.parse(await fs.readFile(path.join(root,'tests/fixtures/required-routes.json'),'utf8'));
  assert.equal(legacy.length,72);
  const app = createApp({ db: {},config: { secure: false,allowedOrigins: new Set(),storage: root,legacyData: root,frontend: root,sessionKey: randomBytes(32),mfaKey: randomBytes(32) } });
  for (const name of legacy) {
    assert.ok(app.locals.routes.has(name),`Missing native route: ${name}`);
    assert.ok(app.locals.routes.get(name).methods,`Missing method policy: ${name}`);
  }
  assert.equal(app.locals.routes.get('users/list').roles.includes(1),false);
});
async function zipped(entries) {
  const zip = new yazl.ZipFile(), chunks=[];
  const done = new Promise((resolve,reject) => { zip.outputStream.on('data',chunk=>chunks.push(chunk)); zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks))); zip.outputStream.on('error',reject); });
  for (const [name,body] of entries) zip.addBuffer(Buffer.from(body),name);
  zip.end(); return done;
}
test('DOCX validation accepts bundled Word templates and rejects XML/macro abuse', async () => {
  const template = await fs.readFile(path.join(root,'resources/templates/shift_change_form.docx'));
  await validateDocx(template,'template.docx');
  const base = [['[Content_Types].xml','wordprocessingml.document.main+xml'],['word/document.xml','<document/>']];
  for (const entry of [['word/vbaProject.bin','x'],['word/_rels/document.xml.rels','<Relationship TargetMode="External"/>'],['word/evil.xml','<!DOCTYPE evil><x/>']]) {
    await assert.rejects(validateDocx(await zipped([...base,entry]),'evil.docx'));
  }
  await assert.rejects(validateDocx(Buffer.alloc(2097153),'big.docx'));
});
test('Google credentials cannot override token endpoint to reach private hosts', () => {
  assert.throws(() => validateCredentials(Buffer.from(JSON.stringify({ type: 'service_account',client_email: 'a@b.gserviceaccount.com',token_uri: 'http://169.254.169.254/',private_key: 'x' }))));
});
