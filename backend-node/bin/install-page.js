export function installerPage(token,installed=false) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ติดตั้ง Vengg4 Node.js</title>
<style>*{box-sizing:border-box}body{font:16px/1.6 system-ui;background:#f0f4fa;color:#17243a;margin:32px auto;max-width:760px;padding:16px}main{background:white;padding:28px;border-radius:14px}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;width:100%}button{background:#175cc5;color:white;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#result{white-space:pre-wrap}small{color:#52627b}[hidden]{display:none!important}a{color:#175cc5}</style></head><body><main>
<h1>ติดตั้ง Vengg4 • Node.js</h1>
<p>ตั้งค่าทั้งหมดผ่านหน้านี้ ไม่ต้องกรอกข้อมูลหรือรันคำสั่งในหน้าต่าง CMD</p>
<form id="setup" autocomplete="off" ${installed?'hidden':''}>
<label>รูปแบบ<select name="mode"><option value="create">สร้างฐานและบัญชีแอปใหม่</option><option value="connect">เชื่อมฐานเดิมและเพิ่มตารางความปลอดภัย</option></select></label>
<label>URL เว็บไซต์<input name="public_origin" value="http://localhost:3000" type="url" required></label>
<label>พอร์ต MySQL<input name="db_port" type="number" min="1" max="65535" value="3306" required></label>
<label>ชื่อฐาน<input name="db_name" value="vengg4_db" required pattern="[A-Za-z][A-Za-z0-9_]{0,63}"></label>
<label>บัญชีแอป (ไม่ใช้ root)<input name="db_user" value="vengg4_app" required></label>
<label>รหัสบัญชีแอป<input name="db_password" type="password" autocomplete="new-password" required></label>
<label>บัญชีผู้ดูแล MySQL ที่สร้างตารางได้<input name="admin_user" value="root" required></label>
<label>รหัสผู้ดูแล MySQL<input name="admin_password" type="password" autocomplete="current-password"></label>
<label>รหัสแอดมินเว็บใหม่ (12–72 UTF-8 bytes)<input name="app_admin_password" type="password" autocomplete="new-password" required></label>
<label>ยืนยันรหัสแอดมินเว็บ<input name="confirm_password" type="password" autocomplete="new-password" required></label>
<p><small>โหมดเชื่อมฐานเดิมไม่ลบข้อมูลและคงผู้ดูแลเดิม รหัส MySQL root ไม่บันทึกลงไฟล์ การย้ายจะยกเลิก session เก่าของ PHP แอดมินต้องเปิด MFA ตอนเข้าสู่ระบบ</small></p>
<label><input style="width:auto" type="checkbox" required>ฉันสำรองฐานและไฟล์แล้ว และพร้อมให้ระบบเพิ่มตาราง Node.js</label>
<button id="submit">ตรวจและติดตั้ง</button></form>
<p id="result" role="status">${installed?'ติดตั้งไว้แล้ว ระบบจะไม่เขียนทับค่าหรือฐานเดิม กดเปิดระบบเพื่อใช้งาน':''}</p>
<button id="start" ${installed?'':'hidden'}>เปิดระบบและเข้าสู่หน้า Login</button><a id="open" hidden>เข้าสู่ระบบ Vengg4</a>
</main><script>
const token=${JSON.stringify(token)},form=document.getElementById('setup'),button=document.getElementById('submit'),start=document.getElementById('start'),result=document.getElementById('result'),open=document.getElementById('open');
async function post(url,data){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':token},body:JSON.stringify(data)});const payload=await response.json();if(!response.ok)throw Error(payload.error||'ทำรายการไม่สำเร็จ');return payload}
form.onsubmit=async event=>{event.preventDefault();button.disabled=true;result.textContent='กำลังตรวจและติดตั้ง...';try{const data=await post('/setup',Object.fromEntries(new FormData(form)));result.textContent=data.message;if(data.success){form.hidden=true;start.hidden=false}}catch(error){result.textContent=error.message}finally{button.disabled=false;for(const input of form.querySelectorAll('input[type=password]'))input.value=''}};
start.onclick=async()=>{start.disabled=true;result.textContent='กำลังเปิดระบบ...';try{const data=await post('/start',{});open.href=data.open_url;open.hidden=false;result.textContent='ระบบพร้อมใช้งานแล้ว';window.location.assign(data.open_url)}catch(error){result.textContent=error.message;start.disabled=false}};
</script></body></html>`;
}
