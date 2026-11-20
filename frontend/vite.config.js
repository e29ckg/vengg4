import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': process.env.DEV_API_TARGET || 'http://127.0.0.1:3000',
      '/vengg4/api': process.env.DEV_API_TARGET || 'http://127.0.0.1:3000',
    },
  },
})
