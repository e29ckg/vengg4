<template>
  <div class="container py-4" style="max-width:900px">
    <div class="card shadow-sm"><div class="card-header bg-dark text-white py-3"><h5 class="mb-0">อัปเดตโปรแกรม Node.js</h5></div>
      <div class="card-body">
        <p v-if="version?.repository">ตรวจเวอร์ชันจาก GitHub {{ version.repository }} สาขา main</p>
        <p v-else>ยังไม่ได้ตั้งค่าแหล่งตรวจเวอร์ชัน ให้ผู้ดูแลกำหนด UPDATE_REPOSITORY เมื่อมี GitHub repository ของโปรเจกต์แล้ว</p>
        <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>
        <dl v-if="version" class="row"><dt class="col-sm-4">เวอร์ชันติดตั้ง</dt><dd class="col-sm-8"><code>{{ version.current }}</code></dd><dt class="col-sm-4">เวอร์ชันล่าสุด</dt><dd class="col-sm-8"><code>{{ version.latest }}</code></dd></dl>
        <div class="alert alert-info">{{ version?.message || 'การอัปเดต Node.js ทำผ่านผู้ดูแลเซิร์ฟเวอร์ เพื่อสำรองข้อมูล ตรวจ migration และ restart service ตามคู่มือ README.md' }}</div>
        <p>หน้าเว็บไม่มีสิทธิ์รัน Git/npm หรือเปลี่ยนโค้ดที่กำลังทำงาน ให้ผู้ดูแล deploy รุ่นใหม่ตามขั้นตอนในคู่มือ หลังอัปเดตอาจต้องเข้าสู่ระบบใหม่</p>
        <button class="btn btn-outline-primary" :disabled="checking" @click="check">{{ checking?'กำลังตรวจสอบ...':'ตรวจเวอร์ชัน' }}</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import {ref,onMounted} from 'vue'
import api from '../../services/api'
const version=ref(null),error=ref(''),checking=ref(false)
async function check(){checking.value=true;error.value='';try{version.value=(await api.get('?route=admin/program/status',{timeout:15000})).data}catch(e){error.value=e.response?.data?.error||'ตรวจเวอร์ชันไม่ได้'}finally{checking.value=false}}
onMounted(check)
</script>
