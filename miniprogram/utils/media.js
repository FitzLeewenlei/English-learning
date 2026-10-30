const config = require('../config');
const manifest = require('../data/audio-manifest');
const packages = {};
const resolved = {};
function loadPackage(name) {
  if (packages[name]) return packages[name];
  if (!wx.loadSubpackage) return Promise.reject(new Error('当前微信版本不支持音频分包，请更新微信。'));
  packages[name] = new Promise((resolve, reject) => wx.loadSubpackage({
    name, success: resolve, fail: err => { delete packages[name]; reject(err); }
  }));
  return packages[name];
}
function localFile(record) {
  return loadPackage(record.package).then(() => new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    const dir = wx.env.USER_DATA_PATH + '/haina-audio-v1';
    const path = dir + '/' + record.hash + (record.extension || '.mp3');
    fs.access({ filePath: path, success: () => resolve(path), fail: () => {
      try { fs.mkdirSync(dir, true); } catch (_) { /* Directory may already exist. */ }
      fs.readFile({ filePath: record.path, success: result => {
        fs.writeFile({ filePath: path, data: result.data, success: () => resolve(path), fail: reject });
      }, fail: reject });
    } });
  }));
}
function resolveAudio(source) {
  if (!source) return Promise.reject(new Error('该词暂未配音。'));
  if (/^(https:\/\/|cloud:\/\/|wxfile:\/\/|http:\/\/tmp\/)/.test(source)) return Promise.resolve(source);
  if (resolved[source]) return Promise.resolve(resolved[source]);
  if(config.audioCloudRoot){
    if(!wx.cloud||!getApp().globalData.cloudReady)return Promise.reject(new Error('在线音频服务尚未开通，请联系老师。'));
    return Promise.resolve(config.audioCloudRoot.replace(/\/$/,'')+'/'+source);
  }
  const record = manifest[source];
  if (config.bundledAudio && record) {
    return localFile(record).then(path => { resolved[source] = path; return path; }).catch(err => {
      if (config.audioBaseUrl) return config.audioBaseUrl.replace(/\/$/, '') + '/' + source;
      throw new Error('音频资源暂未加载成功，请重试。' + (err.errMsg || err.message || ''));
    });
  }
  if (config.audioBaseUrl) return Promise.resolve(config.audioBaseUrl.replace(/\/$/, '') + '/' + source);
  return Promise.reject(new Error('这条录音尚未上架。'));
}
module.exports = { resolveAudio };
