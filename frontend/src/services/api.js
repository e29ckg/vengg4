import axios from 'axios'
import router from '../router'
import { clearSession } from './session'

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api/'
const api = axios.create({ baseURL, withCredentials: true, timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 30000 })
const csrfClient = axios.create({ baseURL, withCredentials: true, timeout: 15000 })
let csrfToken = '', pendingCsrf = null
export async function getCsrfToken() {
  if (csrfToken) return csrfToken
  if (!pendingCsrf) pendingCsrf = csrfClient.get('?route=auth/csrf').then(({ data }) => {
    csrfToken = data.csrf_token
    if (!csrfToken) throw new Error('ไม่สามารถเตรียม CSRF token ได้')
    return csrfToken
  }).finally(() => { pendingCsrf = null })
  return pendingCsrf
}
api.interceptors.request.use(async config => {
  if (['post','put','patch','delete'].includes(config.method?.toLowerCase())) config.headers['X-CSRF-Token'] = await getCsrfToken()
  if (config.data instanceof FormData) config.headers.delete('Content-Type')
  else if (['post','put','patch'].includes(config.method?.toLowerCase())) config.headers['Content-Type'] = 'application/json'
  return config
})
api.interceptors.response.use(response => response, async error => {
  const { status, data } = error.response || {}
  if (status === 403 && data?.code === 'CSRF' && !error.config._csrfRetried) {
    error.config._csrfRetried = true
    csrfToken = ''
    error.config.headers['X-CSRF-Token'] = await getCsrfToken()
    return api.request(error.config)
  }
  const challengeRoute = /route=auth\/(?:login|mfa\/(?:verify|confirm|setup|disable|recovery))/.test(error.config?.url || '')
  if (status === 401 && (!challengeRoute || data?.code === 'AUTH_REQUIRED')) {
    clearSession()
    router.push('/login')
  }
  return Promise.reject(error)
})
export default api
