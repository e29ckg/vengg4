<template>
  <div class="container d-flex justify-content-center align-items-center min-vh-100 py-4">
    <div class="card shadow-sm border-0 rounded-4 p-4" style="width:100%;max-width:460px">
      <div class="text-center mb-4"><h3 class="fw-bold text-primary">Vengg4</h3><p class="text-muted">ระบบจัดการเวรนอกเวลาทำการ</p></div>
      <template v-if="codes.length">
        <h5>เก็บ recovery codes</h5><p>ใช้แทนรหัสจากแอปเมื่อเข้าแอปไม่ได้ แต่ละรหัสใช้ได้ครั้งเดียว เก็บในที่ปลอดภัยแยกจากโทรศัพท์</p>
        <div class="bg-light rounded p-3 mb-3"><div v-for="value in codes" :key="value"><code>{{ value }}</code></div></div>
        <button class="btn btn-outline-secondary mb-3" @click="downloadCodes">ดาวน์โหลดรหัส</button>
        <label class="form-check mb-3"><input v-model="saved" type="checkbox" class="form-check-input">ฉันเก็บรหัสสำรองไว้แล้ว</label>
        <button class="btn btn-primary w-100" :disabled="!saved" @click="finish">เข้าสู่ระบบ</button>
      </template>
      <form v-else-if="challenge" @submit.prevent="verify">
        <h5>{{ challenge.enrollment_required ? 'เปิด MFA ก่อนเข้าใช้งาน' : 'ยืนยันตัวตนด้วย MFA' }}</h5>
        <p v-if="challenge.enrollment_required">ผู้ดูแลระบบต้องเปิด MFA สแกน QR นี้ด้วยแอป Authenticator แล้วกรอกรหัส 6 หลัก</p>
        <template v-if="challenge.enrollment_required">
          <img :src="challenge.qr_code" alt="QR สำหรับเพิ่มบัญชีใน Authenticator" class="d-block mx-auto" style="width:220px;max-width:100%">
          <details class="mb-3"><summary>เพิ่มด้วยคีย์แทน QR</summary><code class="text-break">{{ challenge.secret }}</code></details>
        </template>
        <label for="mfa-code" class="form-label">{{ challenge.enrollment_required ? 'รหัส 6 หลัก' : 'รหัสจาก Authenticator หรือ recovery code' }}</label>
        <input id="mfa-code" v-model="code" class="form-control mb-3" autocomplete="one-time-code" :inputmode="challenge.enrollment_required ? 'numeric' : 'text'" required maxlength="32" autofocus>
        <p class="small text-muted">ขั้นตอนนี้มีอายุ 5 นาที รหัสจากแอปที่ใช้แล้วจะใช้ซ้ำไม่ได้</p>
        <button class="btn btn-primary w-100" :disabled="busy">{{ busy ? 'กำลังตรวจสอบ...' : 'ยืนยัน' }}</button>
        <button type="button" class="btn btn-link w-100 mt-2" :disabled="busy" @click="restart">เริ่มเข้าสู่ระบบใหม่</button>
      </form>
      <form v-else @submit.prevent="login">
        <div class="mb-3"><label for="username" class="form-label">ชื่อผู้ใช้</label><input id="username" v-model="username" class="form-control" autocomplete="username" required maxlength="128"></div>
        <div class="mb-4"><label for="password" class="form-label">รหัสผ่าน</label><input id="password" v-model="password" type="password" class="form-control" autocomplete="current-password" required></div>
        <button class="btn btn-primary w-100" :disabled="busy">{{ busy ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ' }}</button>
      </form>
      <p v-if="error" class="alert alert-danger mt-3 mb-0" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../services/api'
import { storeSession } from '../services/session'
const username=ref(''),password=ref(''),code=ref(''),busy=ref(false),error=ref(''),challenge=ref(null),codes=ref([]),saved=ref(false)
const router=useRouter();let pendingUser=null
function finish(){if(pendingUser){storeSession(pendingUser);pendingUser=null;codes.value=[];router.push('/home')}}
function restart(){challenge.value=null;code.value='';password.value='';error.value=''}
async function accept(data){
  if(data.mfa_required){challenge.value=data;return}
  if(!data.authenticated||!data.user)throw Error('ผลการเข้าสู่ระบบไม่ถูกต้อง')
  pendingUser=data.user;challenge.value=null
  if(data.recovery_codes){codes.value=data.recovery_codes;return}
  finish()
}
async function submit(task){busy.value=true;error.value='';try{await task()}catch(e){error.value=e.response?.data?.message||e.response?.data?.error||e.message||'เชื่อมต่อไม่สำเร็จ'}finally{busy.value=false}}
function login(){return submit(async()=>{try{await accept((await api.post('?route=auth/login',{username:username.value,password:password.value})).data)}finally{password.value=''}})}
function verify(){return submit(async()=>{try{const route=challenge.value.enrollment_required?'confirm':'verify';await accept((await api.post(`?route=auth/mfa/${route}`,{code:code.value.trim()})).data)}finally{code.value=''}})}
function downloadCodes(){const url=URL.createObjectURL(new Blob([codes.value.join('\n')+'\n'],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download='vengg4-recovery-codes.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
</script>
