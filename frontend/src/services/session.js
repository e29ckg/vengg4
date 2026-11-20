export function clearSession() {
  for (const key of ['token','user','user_id','role','username','avatar']) localStorage.removeItem(key)
  window.dispatchEvent(new Event('user-updated'))
}
export function storeSession(user) {
  // A UI marker only. The actual session secret is an HttpOnly cookie.
  localStorage.setItem('token', 'session')
  localStorage.setItem('user_id', user.id)
  localStorage.setItem('role', user.role)
  localStorage.setItem('username', user.fullname || user.username)
  localStorage.setItem('avatar', user.avatar || '')
  window.dispatchEvent(new Event('user-updated'))
}
if (localStorage.getItem('token') && localStorage.getItem('token') !== 'session') clearSession()
