const PREFIX = 'haina:v1:';
function scope() {
  try { const p = wx.getStorageSync(PREFIX + 'profile'); return p && p.id ? p.id : 'guest'; }
  catch (_) { return 'guest'; }
}
function key(name, personal) { return PREFIX + (personal ? scope() + ':' : '') + name; }
function get(name, fallback, personal) {
  try { const result = wx.getStorageSync(key(name, personal)); return result === '' || result === undefined ? fallback : result; }
  catch (_) { return fallback; }
}
function set(name, value, personal) {
  try { wx.setStorageSync(key(name, personal), value); return true; }
  catch (_) { wx.showToast({ title: '本机空间不足，记录未保存', icon: 'none' }); return false; }
}
module.exports = { get, set, scope };
