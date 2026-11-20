<template>
  <div class="card shadow-sm border-0 mb-4">
    <div class="card-header bg-light fw-bold">ยืนยันตัวตนสองขั้นตอน (MFA)</div>
    <div class="card-body">
      <p v-if="status">สถานะ: <strong>{{ status.enabled?'เปิดใช้งาน':'ยังไม่เปิด' }}</strong> <span v-if="status.required">• ผู้ดูแลระบบต้องเปิด MFA</span></p>
      <p v-if="status?.enabled" class="text-muted">Recovery codes เหลือ {{ status.recovery_remaining }} รหัส</p>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <template v-if="codes.length">
        <p>แสดงรหัสใหม่ครั้งเดียว รหัสชุดเดิมถูกยกเลิกแล้ว เก็บรหัสเหล่านี้ในที่ปลอดภัย</p>
        <div class="bg-light p-3 rounded"><div v-for="code in codes" :key="code"><code>{{ code }}</code></div></div>
        <button class="btn btn-outline-primary mt-3" @click="download">ดาวน์โหลดรหัส</button>
        <button class="btn btn-secondary mt-3 ms-2" @click="codes=[]">เก็บแล้ว</button>
      </template>
      <form v-else-if="setup" @submit.prevent="confirm">
        <p>สแกน QR ด้วยแอป Authenticator และกรอกรหัสเพื่อยืนยัน</p><img :src="setup.qr_code" alt="QR ตั้งค่า MFA" style="width:220px;max-width:100%">
        <details><summary>คีย์สำหรับเพิ่มเอง</summary><code class="text-break">{{ setup.secret }}</code></details>
        <label class="form-label mt-3">รหัส 6 หลัก<input v-model="code" class="form-control" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label>
        <div><button class="btn btn-primary" :disabled="busy">ยืนยันเปิด MFA</button><button type="button" class="btn btn-link" @click="setup=null">ยกเลิก</button></div>
      </form>
      <form v-else-if="status" @submit.prevent="status.enabled?rotate():enroll()">
        <label class="form-label d-block">รหัสผ่านปัจจุบัน<input v-model="password" type="password" class="form-control" autocomplete="current-password" required></label>
        <label v-if="status.enabled" class="form-label d-block">รหัส Authenticator หรือ recovery code<input v-model="code" class="form-control" autocomplete="one-time-code" required maxlength="32"></label>
        <button class="btn btn-primary" :disabled="busy">{{ status.enabled?'สร้าง recovery codes ชุดใหม่':'ตั้งค่า MFA' }}</button>
        <button v-if="status.enabled&&!status.required" type="button" class="btn btn-outline-danger ms-2" :disabled="busy||!password||!code" @click="disable">ปิด MFA</button>
      </form>
    </div>
  </div>
</template>
<script setup>
import { ref,onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../services/api'
import { clearSession,storeSession } from '../services/session'
const status=ref(null),password=ref(''),code=ref(''),setup=ref(null),codes=ref([]),error=ref(''),busy=ref(false),router=useRouter()
async function load(){status.value=(await api.get('?route=auth/mfa/status')).data}
async function run(task){busy.value=true;error.value='';try{await task();await load()}catch(e){error.value=e.response?.data?.error||'ทำรายการไม่สำเร็จ'}finally{busy.value=false;password.value='';code.value=''}}
function enroll(){return run(async()=>{setup.value=(await api.post('?route=auth/mfa/setup',{password:password.value})).data})}
function confirm(){return run(async()=>{const {data}=await api.post('?route=auth/mfa/confirm',{code:code.value.trim()});storeSession(data.user);codes.value=data.recovery_codes;setup.value=null})}
function rotate(){return run(async()=>{codes.value=(await api.post('?route=auth/mfa/recovery',{password:password.value,code:code.value.trim()})).data.recovery_codes})}
async function disable(){busy.value=true;error.value='';try{await api.post('?route=auth/mfa/disable',{password:password.value,code:code.value.trim()});clearSession();router.push('/login')}catch(e){error.value=e.response?.data?.error||'ปิด MFA ไม่สำเร็จ'}finally{busy.value=false;password.value='';code.value=''}}
function download(){const url=URL.createObjectURL(new Blob([codes.value.join('\n')+'\n'],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='vengg4-recovery-codes.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
onMounted(()=>load().catch(()=>{error.value='โหลดสถานะ MFA ไม่สำเร็จ'}))
</script>
