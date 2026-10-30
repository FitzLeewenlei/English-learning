const config = require('./config');
const storage = require('./utils/storage');
App({
  globalData: { profile: null, cloudReady: false },
  onLaunch() {
    this.globalData.profile = storage.get('profile', null);
    if (config.cloudEnv && wx.cloud) {
      try {
        wx.cloud.init({ env: config.cloudEnv, traceUser: false });
        this.globalData.cloudReady = true;
      } catch (err) { console.warn('Cloud init failed', err); }
    }
    if(wx.onNetworkStatusChange)wx.onNetworkStatusChange(status=>{
      if(status.isConnected)require('./utils/study').sync().catch(()=>{});
    });
  },
  onShow() { require('./utils/study').sync().catch(()=>{}); },
  onHide() { require('./utils/player').stop(); },
  onError(message) { console.error('Application error:', message); }
});
