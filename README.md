# Vengg4

ระบบจัดการเวรนอกเวลาทำการ พัฒนาต่อจาก Vengg3 รุ่น Node.js ใช้ **Vue 3 + Node.js/Express + MySQL** รองรับการจัดเวร คำสั่ง โอน/สลับ/อนุมัติเวร รายงาน การเงิน เอกสาร DOCX, Google Calendar และ Telegram พร้อม MFA และตัวติดตั้งผ่านหน้าเว็บ

โปรเจกต์นี้แยกจาก Vengg3 มี Git repository ภายในเครื่องของตัวเอง ไม่มี PHP runtime และไม่ต้องติดตั้ง XAMPP การติดตั้งใหม่สร้างฐานและบัญชีแอปแยก โดยค่าเริ่มต้นใช้ `vengg4_db` และ `vengg4_app` ไม่ได้แนบรหัสผ่าน ฐานทดสอบ หรือไฟล์ตั้งค่าจากเครื่องต้นทาง

## สิ่งที่ต้องเตรียม

- Node.js **22.13 ขึ้นไป** พร้อม npm (ใช้รุ่นที่ยังได้รับการสนับสนุนและตรงตาม `engines` ใน package files)
- MySQL **8** ที่เริ่ม service แล้ว เข้าถึงผ่าน `127.0.0.1` ปกติพอร์ต `3306`
- บัญชีผู้ดูแล MySQL ที่สร้างฐาน ตาราง และบัญชีแอปได้ ใช้เฉพาะระหว่างติดตั้ง
- Apache **2.4** เมื่อต้องการให้บริการผ่าน Apache/HTTPS; ทดสอบในเครื่องด้วย Node โดยตรงได้
- แอป Authenticator สำหรับบัญชีผู้ดูแล เช่นแอปที่รองรับ TOTP
- อินเทอร์เน็ตระหว่างติดตั้ง dependencies; ZIP ติดตั้งที่ build แล้วรวม dependencies ของ backend ไว้ให้

สำหรับตัวอย่าง Windows ด้านล่าง สมมติวางโปรเจกต์ที่ `C:\Vengg4` ให้เปลี่ยนพาธตามเครื่องจริง ไม่ต้องติดตั้ง PHP หรือ Composer

## ติดตั้งใหม่ผ่านหน้าเว็บบน Windows

### 1. เตรียมโปรเจกต์

เปิด PowerShell ในโฟลเดอร์โปรเจกต์ แล้วรันครั้งแรก:

```powershell
cd C:\Vengg4
npm run deps
npm run build
```

คำสั่งแรกติดตั้งแพ็กเกจตาม lockfiles ของ backend/frontend ส่วน build สร้าง `frontend/dist` สำหรับ URL `/vengg4/` ไม่ต้องสร้าง `.env` ด้วยตัวเองก่อนเปิด wizard

หากใช้ ZIP `vengg4-native-windows.zip` ที่สร้างด้วย `npm run package` ให้แตก ZIP แล้วเข้าโฟลเดอร์ `vengg4-native` ข้างในมี frontend ที่ build แล้วและ backend dependencies จึงข้ามคำสั่งเตรียมด้านบนได้ แต่เครื่องปลายทางยังต้องมี Node.js และ MySQL

### 2. เปิดตัวติดตั้ง

ดับเบิลคลิก **`Install-Native.cmd`** ระบบเปิดตัวติดตั้งในเบราว์เซอร์ที่ [http://localhost:3001](http://localhost:3001) ข้อมูลการติดตั้งทั้งหมดกรอกผ่านหน้าเว็บ ไม่มีคำถามให้ตอบใน CMD

อีกทางหนึ่งเปิดจาก source ด้วย:

```powershell
npm run install:web
```

จากนั้นเปิด URL เดียวกันด้วยเบราว์เซอร์ ตัวติดตั้งรับการเชื่อมต่อจากเครื่องนี้เท่านั้น พอร์ต `3001` ต้องว่าง และ backend ใช้พอร์ต `3000` หากกำลังรัน Vengg3 บนพอร์ตเหล่านี้ ให้หยุด process เดิมก่อนทดสอบการติดตั้ง Vengg4

### 3. กรอกข้อมูล

| ช่องในหน้าเว็บ | ค่าตัวอย่าง/ความหมาย |
| --- | --- |
| รูปแบบ | **สร้างฐานและบัญชีแอปใหม่** สำหรับติดตั้งใหม่ |
| URL เว็บไซต์ | `http://localhost:3000` สำหรับทดสอบตรงกับ Node หรือ `https://ชื่อเว็บ` สำหรับ Apache HTTPS ไม่ใส่ `/vengg4/` ในช่องนี้ |
| พอร์ต MySQL | `3306` หรือพอร์ตของ MySQL ที่ติดตั้งไว้ |
| ชื่อฐาน | `vengg4_db` ต้องยังไม่มีฐานชื่อนี้ |
| บัญชีแอป | `vengg4_app` ต้องยังไม่มีบัญชีนี้ ไม่ใช้ `root` เป็นบัญชี runtime |
| รหัสบัญชีแอป | ตั้งรหัสใหม่ 12–72 UTF-8 bytes |
| บัญชี/รหัสผู้ดูแล MySQL | บัญชีที่มีสิทธิ์ติดตั้ง ใช้ชั่วคราว ไม่บันทึกรหัสนี้ลง `.env` |
| รหัสแอดมินเว็บ/ยืนยัน | รหัสใหม่สำหรับบัญชีเว็บ `admin` 12–72 UTF-8 bytes |

ยืนยันการสำรองข้อมูล แล้วกด **ตรวจและติดตั้ง** ตัวติดตั้งสร้าง schema และ migrations, บัญชีแอปสิทธิ์ `SELECT/INSERT/UPDATE/DELETE`, แอดมินเว็บ และ `backend-node/.env` พร้อมกุญแจ session/MFA สุ่มคนละชุด ไม่ต้อง import SQL เองสำหรับการติดตั้งใหม่

โหมด **เชื่อมฐานเดิม** ใช้สำหรับย้ายระบบ ไม่ใช่ติดตั้งใหม่ อ่านหัวข้อย้ายข้อมูลก่อนเลือกโหมดนี้ ห้ามนำ schema สำหรับติดตั้งใหม่ไป import ทับฐานที่มีข้อมูล

### 4. เปิดระบบและตั้ง MFA

กด **เปิดระบบและเข้าสู่หน้า Login** หากใช้ Node โดยตรงจะเปิด [http://localhost:3000/vengg4/](http://localhost:3000/vengg4/) หากกรอก URL Apache ให้ตั้ง Apache ตามหัวข้อถัดไปก่อนเข้าเว็บ

เข้าสู่ระบบด้วย `admin` และรหัสที่ตั้งใน wizard จากนั้นสแกน QR ด้วย Authenticator กรอกรหัส 6 หลัก และเก็บ recovery codes ในที่ปลอดภัย ระบบแสดง recovery codes เมื่อสร้างเท่านั้น ผู้ดูแลต้องตั้ง MFA ให้สำเร็จก่อนใช้งาน ส่วนผู้ใช้ทั่วไปเลือกเปิด MFA ได้จากโปรไฟล์

### 5. การเปิดใช้งานครั้งถัดไป

ดับเบิลคลิก **`Start-Native.cmd`** หรือรันจาก root ของโปรเจกต์:

```powershell
npm --prefix backend-node start
```

โปรแกรมอ่าน `backend-node/.env` และใช้ฐานเดิม ต้องเปิด process ค้างไว้ หาก wizard ยังเปิด backend อยู่แล้ว ไม่ต้องสั่ง start ซ้ำ ปิด process เดิมก่อนเปลี่ยนมาเริ่มด้วยคำสั่งนี้

สำหรับใช้งานต่อเนื่อง ให้ผู้ดูแลตั้ง Windows service ผ่าน service manager ขององค์กร โดยใช้ `node.exe --env-file=.env src/server.js` และ working directory เป็น `C:\Vengg4\backend-node` บัญชี service อ่าน source/`.env` และเขียน `storage` ได้ ไม่ควรมีสิทธิ์แก้ source หรือเป็น Administrator

## คอนฟิก Apache โดยไม่ใช้ XAMPP

ติดตั้ง Apache แยกและเปิด modules `proxy_module`, `proxy_http_module`, `headers_module` รวมถึง modules มาตรฐาน alias/dir/authz สำหรับ HTTPS ต้องมี `ssl_module` และ certificate ด้วย

1. คัดลอก `deploy/node-apache.conf` ไป `C:\Apache24\conf\extra\vengg4-node.conf`
2. แก้พาธ `C:/Vengg4/frontend/dist` ในไฟล์ให้ตรงกับที่ติดตั้ง
3. เพิ่มบรรทัดนี้ใน `httpd.conf` เพียงครั้งเดียว:

```apache
Include "C:/Apache24/conf/extra/vengg4-node.conf"
```

ไฟล์ตัวอย่างให้ Apache เสิร์ฟ `frontend/dist` ที่ `/vengg4/` และ proxy `/vengg4/api` ไป Node `http://127.0.0.1:3000/api` มี security headers และ SPA fallback แล้ว ไม่ใช้ PHP handler ของแอป

ตรวจ syntax ก่อน restart Apache:

```powershell
& C:\Apache24\bin\httpd.exe -t
```

ทดสอบ local ผ่าน [http://localhost/vengg4/](http://localhost/vengg4/) โดย `PUBLIC_ORIGIN` ใน `backend-node/.env` ต้องเป็น `http://localhost` ตาม origin ที่เข้าจริง แล้ว restart Node เมื่อแก้ `.env` ตัวอย่าง Apache ใช้ `Require local` จึงอนุญาตเฉพาะเครื่องนี้ สำหรับ LAN ให้ผู้ดูแลกำหนด `Require ip` ตามเครือข่ายที่ต้องการภายใน HTTPS VirtualHost

ก่อนใช้งาน production กำหนด HTTPS VirtualHost และย้าย directives ของไฟล์ตัวอย่างเข้า VirtualHost นั้น จากนั้นตั้งใน `backend-node/.env`:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://เวบบนโดเมนจริง
COOKIE_SECURE=true
TRUST_PROXY=true
TRUST_PROXY_CIDRS=loopback
```

เปลี่ยนโดเมนตัวอย่างให้เป็นชื่อจริง และให้ Apache **เขียนทับ** header นี้ภายใน HTTPS VirtualHost:

```apache
RequestHeader set X-Forwarded-Proto "https"
Header always set Strict-Transport-Security "max-age=31536000"
```

restart Node และ Apache แล้วตรวจ login/MFA ผ่าน URL HTTPS จริง ไม่เปิด backend port สู่ภายนอก และไม่เปิดเผย source, `.env` หรือ `storage` เป็น DocumentRoot โหมด production ปฏิเสธ HTTP และใช้ Secure/HttpOnly session cookies

## การพัฒนา (dev)

ติดตั้งผ่าน wizard บน **ฐาน dev แยก** ก่อน ไม่ชี้ dev ไปฐาน production จากนั้นปิด backend ที่ wizard เปิดไว้ และแก้ `backend-node/.env` ให้เป็น:

```dotenv
NODE_ENV=development
PUBLIC_ORIGIN=http://localhost:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
COOKIE_SECURE=false
TRUST_PROXY=false
```

คง DB และกุญแจชุดเดิมไว้ ตั้ง `frontend/.env.local` เป็น:

```dotenv
VITE_API_BASE_URL=/api/
```

เปิด PowerShell สองหน้าต่างใน root ของโปรเจกต์:

```powershell
# หน้าต่างที่ 1: backend พร้อม watch
npm run dev:backend
```

```powershell
# หน้าต่างที่ 2: frontend พร้อม hot reload
npm run dev:frontend -- --host 127.0.0.1 --port 5173 --strictPort
```

เปิด [http://localhost:5173](http://localhost:5173) Vite proxy `/api` ไป backend พอร์ต `3000` กรณีพอร์ตชนกับโปรเจกต์เดิม ให้เปลี่ยน `PORT`, `PUBLIC_ORIGIN`, `CORS_ALLOWED_ORIGINS` ใน `.env` และกำหนด `$env:DEV_API_TARGET='http://127.0.0.1:พอร์ตใหม่'` ในหน้าต่าง frontend พร้อมเปลี่ยน `--port` ให้ตรงกัน

อย่าใช้ `vite preview` หรือ Vite dev server เป็น service สำหรับ production ให้ใช้ frontend ที่ build แล้วผ่าน Apache หรือ Node

## MFA และการกู้บัญชี

- แอดมิน (`role=9`) ต้องเปิด MFA; ผู้ใช้อื่นเลือกเปิด/ปิดได้ในโปรไฟล์ โดยยืนยันรหัสผ่านและ MFA ของตัวเอง
- TOTP 6 หลัก เปลี่ยนทุก 30 วินาที รหัสที่ใช้สำเร็จแล้วใช้ซ้ำไม่ได้ หากเพิ่งใช้เข้าสู่ระบบ ให้รอรหัสรอบใหม่ก่อนยืนยันงานสำคัญ หรือใช้ recovery code ที่ยังไม่เคยใช้
- แอดมินรีเซ็ตให้บัญชีอื่นได้ที่ **จัดการสมาชิก → รีเซ็ต MFA** หลังยืนยันตัวบุคคลผู้ใช้ แล้วกรอกรหัสผ่านและ MFA/recovery code ของแอดมิน ระบบออกจากระบบทุกอุปกรณ์ ยกเลิกรหัสสำรองเดิม บังคับตั้ง MFA ใหม่ และบันทึก audit โดยไม่เปลี่ยนรหัสผ่านหรือสิทธิ์
- รีเซ็ตตัวเองผ่านปุ่มนี้ไม่ได้ หากไม่มีผู้ดูแลคนอื่นและไม่มี recovery codes ให้ผู้ดูแลเครื่องยืนยันตัวบุคคลก่อนรันจาก `backend-node`:

```powershell
node --env-file=.env bin/reset-mfa.js USERNAME --confirm-identity-verified
```

แทน `USERNAME` ด้วยชื่อบัญชีจริง ผู้ใช้ต้องตั้ง MFA ใหม่หลังคำสั่งสำเร็จ รักษาเวลาบน server และโทรศัพท์ให้ตรงกัน

## ย้ายจาก Vengg3

สำรอง DB, storage และ `.env` ก่อน ทดสอบ restore ในฐานแยก แล้วหยุดการเขียนข้อมูลและ service เก่าระหว่างย้าย

**จาก Vengg3 รุ่น Node.js ที่มี MFA อยู่แล้ว:** คัดลอก `.env` และ storage เดิมไปตำแหน่งที่ปลอดภัยสำหรับ Vengg4 แก้พาธ/origin ให้ตรง และคง `MFA_ENCRYPTION_KEY` ชุดเดิมไว้ รวมถึง `SESSION_SIGNING_KEY` หากต้องการคงการตรวจ session เดิม ห้ามใช้ wizard สร้างกุญแจทับฐานนี้ ระบบคงรูปแบบเข้ารหัสและ metadata ของ Calendar เดิมเพื่ออ่านข้อมูลที่ย้ายมาได้ รัน migrations ด้วยบัญชีที่มีสิทธิ์ DDL ชั่วคราว แล้วเริ่ม service ด้วยบัญชีแอปสิทธิ์ CRUD:

```powershell
# รันจาก root เมื่อกำหนดสิทธิ์ migration ชั่วคราวไว้แล้ว
npm run migrate
```

คืนค่าบัญชี DB เป็น runtime account ก่อน `npm start` migration ตรวจ checksum/lock และเพิ่มตาราง `node_*` ไม่ import schema ใหม่ทับ business tables แต่อาจเพิกถอน legacy auth keys ตามกระบวนการย้าย

**จากรุ่น PHP:** ใช้ฐานสำเนาเพื่อทดลองก่อน โหมดเชื่อมฐานเดิมใน wizard เพิ่มตาราง Node โดยคงข้อมูลธุรกิจและ bcrypt เดิม บัญชีแอปต้องมีอยู่แล้วและเข้าฐานได้ ตั้ง `LEGACY_DATA_DIR` ใน environment ของตัวติดตั้งให้ชี้ไปโฟลเดอร์ backend เดิมก่อนเริ่ม wizard เพื่อคัดลอก avatars/templates และแปลง Google credentials โดยไม่เขียนทับไฟล์ใหม่ เมื่อย้ายจริงต้องปิด PHP API เดิม ผู้ใช้เข้าสู่ระบบใหม่และแอดมินตั้ง MFA

โปรเจกต์ใหม่ไม่แนบ backend PHP หรือข้อมูลผู้ใช้เดิม การคัดลอกไฟล์โปรเจกต์อย่างเดียวไม่ได้ย้ายฐานหรือ storage อัตโนมัติ

## Backup และอัปเดต

สำรอง MySQL, `backend-node/storage` และ `backend-node/.env` แยกจากเว็บ ทดสอบ restore และเก็บกุญแจเข้ารหัสชุดเดิม หากกุญแจหายจะถอด MFA/credentials เดิมไม่ได้ ค่า `DB_PASS_B64` ที่ wizard บันทึกเป็นเพียง base64 ไม่ใช่การเข้ารหัส ต้องจำกัดสิทธิ์อ่านไฟล์ `.env`

ขั้นตอนอัปเดต: สำรอง → เตรียม source รุ่นใหม่ → `npm run deps` → `npm run build` → หยุด service → ใช้ DB/storage/keys เดิม → รัน migration ด้วยสิทธิ์ชั่วคราว → คืน runtime account → เริ่ม service → ตรวจ login/MFA และงานสำคัญ

เมนูอัปเดตตรวจเวอร์ชันได้เมื่อกำหนด `UPDATE_REPOSITORY=owner/repository` และ `APP_COMMIT` ใน environment แล้ว เว็บไม่มีสิทธิ์รัน Git/npm หรือ deploy GitHub repository: [e29ckg/vengg4](https://github.com/e29ckg/vengg4) สาขา `main` (Private ต้องมีสิทธิ์เข้าถึง) การตรวจเวอร์ชันผ่าน GitHub API แบบไม่ล็อกอินอาจแสดง unknown สำหรับ repository แบบ Private

งานแจ้งเตือน Telegram ใช้ process แยกจาก backend จากโฟลเดอร์ `backend-node`:

```powershell
npm run notify -- --dry-run
npm run notify -- --loop
```

ตั้งบัญชี Google/Telegram ผ่านหน้าจัดการระบบ และทดสอบด้วยบัญชีที่อนุญาตก่อนใช้งานจริง `--dry-run` ใช้ตรวจรายการก่อนเปิด process ส่งข้อความ

## ทดสอบและสร้างไฟล์ติดตั้ง

จาก root ของ source โปรเจกต์ (ZIP เป็นชุด runtime ไม่มี source frontend และชุดทดสอบ):

```powershell
npm test
npm run build
npm run package -- --force
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\tests\native-node.test.ps1 -Archive .\dist\vengg4-native-windows.zip
```

ZIP และ checksum อยู่ที่ `dist/vengg4-native-windows.zip` และ `.sha256` ภายในรวม Node backend dependencies, frontend build, migrations, เทมเพลด และ web installer โดยไม่รวม `.env`, storage หรือ PHP

Integration tests ใช้ MySQL แยกด้วย `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASS` แล้วรัน `npm run test:integration` บัญชีทดสอบต้องสร้าง/ลบฐานและบัญชี fixture ได้ **ห้ามใช้ credentials ของ production** หรือบน production server

ตัวช่วย fixture บน Windows ใช้ MariaDB binaries ที่กำหนดเอง โดยต้องมี `mysql_install_db.exe` ข้าง `mysqld.exe`:

```powershell
$env:TEST_MYSQLD='C:\MariaDB\bin\mysqld.exe'
node backend-node/tests/run-isolated.js
```

ตัวช่วยนี้สร้างพอร์ต/data directory ชั่วคราวแล้วลบหลังจบ จึงไม่ต้องใช้ XAMPP ส่วน GitHub Actions มี integration บน MySQL 8; จะทำงานเมื่อมี repository และ push แล้ว

## แก้ปัญหาเบื้องต้น

| อาการ | ตรวจสอบ |
| --- | --- |
| เปิด installer ไม่ได้ | Node/npm, พอร์ต 3001, `backend-node/storage/setup-logs` และ launcher error dialog |
| `EADDRINUSE` | มี backend/installer เดิมหรือ Vengg3 ใช้พอร์ตอยู่ หยุด process ที่เกี่ยวข้องก่อนเริ่มใหม่ |
| Wizard แจ้งฐานหรือบัญชีมีอยู่แล้ว | ใช้ชื่อใหม่สำหรับติดตั้งใหม่ หรือเลือกโหมดเชื่อมฐานเดิมหลังสำรอง ไม่ลบฐานเพื่อแก้ปัญหา |
| มี `.env` แล้ว | ตัวติดตั้งไม่เขียนทับ ใช้ `npm start`; หากย้ายเครื่องให้ใช้ keys เดิม |
| ติดตั้งค้าง | ตรวจ `.env.install.lock`, process และฐาน/บัญชีที่อาจสร้างค้าง ตรวจให้แน่ใจว่าไม่มีตัวติดตั้งทำงานก่อนจัดการ lock |
| API ติดต่อไม่ได้/CSRF | เปิดหน้าและ API ผ่าน origin เดียวกัน ตรวจ Vite proxy หรือ Apache ProxyPass และ `PUBLIC_ORIGIN` ให้ตรง |
| Node แจ้ง migrations ไม่ครบ | หยุด service และรัน `npm run migrate` ด้วยสิทธิ์ที่สร้างตารางได้ |
| กุญแจ MFA ไม่ตรง | กู้ `.env`/`MFA_ENCRYPTION_KEY` เดิม ไม่สุ่มกุญแจใหม่ทับ |
| MFA ไม่ผ่าน | ตรวจเวลา ใช้รหัสรอบใหม่ หรือ recovery code ที่ยังไม่ใช้ |

ดูรายละเอียดและขอบเขตการตรวจที่ [SECURITY_REVIEW_NODE.md](SECURITY_REVIEW_NODE.md)

## โครงสร้าง

```text
backend-node/        Express API, auth/MFA, migrations, web installer, tests
frontend/            Vue UI, development server และ production build
deploy/              Apache config, Windows launcher และ ZIP checks
scripts/             คำสั่ง build จาก root
Install-Native.cmd   เปิดหน้าติดตั้งผ่านเว็บ
Start-Native.cmd     เริ่ม backend ที่ติดตั้งแล้ว
README.md            คู่มือติดตั้งและดูแล Vengg4
```
