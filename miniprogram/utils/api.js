const config = require('../config');
const storage = require('./storage');
function enabled() { return Boolean(config.cloudEnv && wx.cloud && getApp().globalData.cloudReady); }
async function call(action, payload) {
  if (!enabled()) throw new Error('在线班级服务暂未开通，请联系管理员。');
  const result = await wx.cloud.callFunction({ name: config.functionName, data: { action, payload: payload || {} } });
  const data = result.result;
  if (!data || !data.ok) throw new Error((data && data.message) || '操作未完成，请稍后重试。');
  return data.data;
}
function saveProfile(profile) {
  storage.set('profile', profile);
  getApp().globalData.profile = profile;
}
async function refreshProfile() {
  if (!enabled()) return storage.get('profile', null);
  const data = await call('me');
  saveProfile(data.profile);
  return data.profile;
}
function error(err) { wx.showToast({ title: err.message || err.errMsg || '网络暂不可用，请重试', icon: 'none', duration: 2600 }); }
module.exports = { enabled, call, saveProfile, refreshProfile, error };
