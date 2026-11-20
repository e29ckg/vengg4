# การตรวจความปลอดภัยของ Node.js backend

วันที่ตรวจ: 20 พฤศจิกายน 2026 ขอบเขตคือ Vengg4 ที่แยกจาก Node backend ของ Vengg3 การเชื่อมกับ Vue การย้ายฐาน และชุดติดตั้ง ไม่ใช่ penetration test บน production และไม่ใช่การรับรองว่าไม่มีช่องโหว่

## สิ่งที่เปลี่ยนและเหตุผล

| ประเด็น | การแก้ในรุ่น Node.js | หลักฐาน/การตรวจ |
|---|---|---|
| ย้าย API แล้วหลุดการตรวจสิทธิ์ | Registry ครบ 72 route เดิม ทุก route กำหนด HTTP methods และ RBAC, ไม่มี PHP fallback | Automated coverage อ่าน route เดิมแล้วเทียบ registry; integration role user/director/finance/admin |
| บังคับ MFA แล้ว password-only ยังเข้า API ได้ | แอดมินได้เพียง challenge; ยังไม่มี session จนยืนยัน TOTP/enrollment สำเร็จ | Integration ตรวจ API ก่อน/หลัง MFA และปฏิเสธ legacy Bearer token |
| ขโมย session ผ่าน localStorage | ใช้ opaque HttpOnly cookie เก็บเฉพาะ hash ใน DB localStorage มีเพียง UI marker | ตรวจ Set-Cookie, response ไม่มี session token และ client ไม่ส่ง Bearer จาก storage |
| เพิ่ม cookie แล้วเกิด CSRF | Signed double-submit token, SameSite Strict, Origin allowlist, ไม่มี CORS wildcard | HTTP tests forged/missing token, forged Origin, request-method restrictions |
| ลองรหัสผ่าน/MFA จำนวนมาก | DB rate limits ตาม IP/บัญชี, challenge TTL และ attempts; canonical DB user ID ป้องกันเปลี่ยนตัวพิมพ์เพื่อเลี่ยง account limit | Integration persisted counters และชื่อบัญชีรูปแบบต่างกัน |
| ใช้ TOTP/recovery ซ้ำหรือยิงพร้อมกัน | Lock user/challenge/MFA ใน transaction; last_counter และ DELETE recovery hash แบบ atomic | RFC 6238 vectors, replay test, concurrent verification ใช้รหัสเดียวกันสำเร็จครั้งเดียว |
| Secret ในฐานหลุดแล้วนำ MFA ไปใช้ทันที | MFA secret และ integration credentials ใหม่เข้ารหัส AES-256-GCM/AAD; recovery code hash และไม่เก็บ plaintext ใน audit | Encryption tamper/cross-user tests, audit inspection |
| รีเซ็ต MFA แล้วข้ามปัจจัยที่สอง | Admin-only POST + CSRF, ยืนยัน password/MFA ของผู้ดูแลใหม่, จำกัดการลอง, ห้ามรีเซ็ตตัวเอง, revoke target sessions/challenges/recovery และบังคับ enroll ใหม่; audit อยู่ใน transaction | Integration ปฏิเสธสิทธิ์/CSRF/password/code ผิด, ตรวจ session ถูกเพิกถอน, password เดิมคงอยู่, recovery proof ใช้ซ้ำไม่ได้ และ enroll ใหม่สำเร็จ |
| ยกเลิก/อนุมัติเวรเก่าทับข้อมูลใหม่ | Ownership/eligibility/status/date checks, schedule locks, ตรวจคำขอใหม่กว่า | Integration โอน/สลับ/อนุมัติ/ยกเลิกและ stale approval |
| ลากย้ายเวรแล้วลบสำเร็จแต่เพิ่มใหม่ไม่สำเร็จ | เปลี่ยน frontend ให้ใช้ atomic move API ภายใน transaction โดยคง id เดิม | Integration ย้ายวันที่ผ่าน และกรณีเดือนผิดข้อมูลเดิมยังอยู่ |
| Mass assignment/SQL injection | Parameterized queries; identifier/field allowlists; ป้องกัน option type ที่อ้าง prototype | SQL-ish ID, invalid settings/prototype keys และ profile role escalation tests |
| ลบผู้ดูแลคนสุดท้าย | ล็อก active administrators ก่อนเปลี่ยน role/status/delete | Integration last-admin protection |
| ไฟล์ปลอม/zip bomb/XML external entities | Avatar decode/re-encode เป็น WebP; DOCX จำกัด entries/ขนาดจริง, ปฏิเสธ macro/DTD/entity/external relationships/path traversal | Binary upload, bundled DOCX, malicious DOCX unit/integration tests |
| Google credential SSRF | ตรวจ RSA key, service account และ OAuth endpoint ที่กำหนด; request URL คงที่ ไม่รับ token URI ปลายทางอื่น | Malicious token endpoint test |
| งานแจ้งเตือนส่งซ้ำ | Claim unique DB key ก่อนส่ง ไม่ retry ผลคลุมเครืออัตโนมัติ, escape HTML จากชื่อ | Logic tests/fixture และใช้ตาราง delivery log เดิม |
| เว็บมีสิทธิ์รัน Git/npm | เปลี่ยนเป็นตรวจเวอร์ชันอย่างเดียว การเปลี่ยน code/dependencies ทำโดยผู้ดูแลผ่าน deploy | Node HTTP ไม่มี child_process หรือ shell execution; update endpoint ปฏิเสธพร้อมอธิบายวิธี deploy |
| ย้ายแล้วล้างข้อมูลเดิม | Additive node_* migrations, DB migration lock/checksum, ไม่รัน resources/schema.sql บนฐานเดิม | Idempotent migration และจำนวน users/schedules ใน fixture คงเดิม |
| ติดตั้งซ้ำแล้วกุญแจ MFA ไม่ตรง | Wizard ไม่สร้าง key ใหม่ทับฐานที่มี MFA; migration/startup ตรวจถอด encrypted state ก่อนเปิดระบบ | Integration wrong-key rejection, reinstall refusal และไม่มีไฟล์ .env ใหม่ถูกสร้าง |

## การทดสอบที่ต้องผ่าน

ผลที่รันในเครื่อง: unit/security ของ Node 10 tests, integration บน MySQL-compatible fixture แยก 21 tests และ frontend 14 tests ผ่าน พร้อม production build และการสร้าง ZIP ตรวจ route coverage ได้ครบ 72 ชื่อ การทดสอบ MySQL 8 ใน GitHub Actions ยังต้องรอให้ push แล้ว CI ทำงาน

- `npm test --prefix backend-node`: RFC TOTP, encryption, PHP bcrypt compatibility, CSRF, recovery hashes, validation, route coverage, DOCX และ credential validation
- `node backend-node/tests/run-isolated.js`: API/security integration บนฐานชั่วคราวแยก และ bootstrap สร้างบัญชีแอปแบบ CRUD เท่านั้น
- `npm test --prefix frontend` และ production build ของ Vue
- `npm audit --prefix backend-node --omit=dev` และ frontend audit ตาม lockfile
- CI เพิ่ม MySQL 8 integration และ Node installation package บน Windows ไม่มีการใช้ credentials ของ production

## ขอบเขตและการตั้งค่าที่ต้องตรวจบนเครื่องจริง

1. ยังต้องทดสอบ Google Calendar/Telegram กับบัญชีที่ได้รับอนุญาต และการคืนข้อมูล backup บน staging การทดสอบไม่ส่งข้อความหรือแก้ Calendar จริง
2. ตรวจ HTTPS/certificate, firewall, Apache proxy, process account และ NTFS/Unix permissions จริง ต้องปิด PHP API เดิมเมื่อสลับมา Node มิฉะนั้นผู้ใช้ยังอาจเข้าเส้นทางที่ไม่มี MFA ได้
3. TOTP ไม่ทน phishing เท่ากับ passkeys และอาศัยนาฬิกาเครื่องที่ถูกต้อง ตั้ง time sync และรักษา recovery codes/กุญแจเข้ารหัส การกู้ MFA ผ่าน CLI ต้องยืนยันตัวบุคคลก่อนใช้
4. Browser extension หรือ XSS ที่ทำงานใน origin เดียวกันยังอาจสั่งงานแทนผู้ใช้ได้ แม้จะอ่าน HttpOnly session ไม่ได้ จึงคง CSP, output sanitization และหลีกเลี่ยง HTML จากข้อมูลผู้ใช้
5. ทบทวน dependency audit เมื่ออัปเดต lockfiles และตรวจ load/concurrency, backup restore, business rules กับข้อมูล staging ก่อน cutover ไม่มีการแก้ production DB หรือเปิด service production ระหว่างการตรวจนี้

แนวทางอ้างอิง: [Express security](https://expressjs.com/en/advanced/best-practice-security/), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html), [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [Node crypto](https://nodejs.org/api/crypto.html)
