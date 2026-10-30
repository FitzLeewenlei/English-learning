const api=require('../../utils/api');const storage=require('../../utils/storage');const study=require('../../utils/study');const config=require('../../config');
Page({
  data:{profile:null,stats:{},goal:15,cloud:false,syncText:'',version:config.version},
  onShow(){this.refresh();if(api.enabled())api.refreshProfile().then(()=>this.refresh()).catch(()=>{});},
  refresh(){const stats=study.summary();this.setData({profile:storage.get('profile',null),stats,goal:study.goal(),cloud:api.enabled(),syncText:stats.lastSync?new Date(stats.lastSync).toLocaleString('zh-CN'):'尚未同步'});},
  editGoal(e){this.setData({goal:e.detail.value});},
  saveGoal(){study.setGoal(this.data.goal);this.refresh();wx.showToast({title:'计划已保存',icon:'success'});},
  async sync(){try{if(!api.enabled()){wx.showToast({title:'当前为本机学习模式',icon:'none'});return;}wx.showLoading({title:'同步中'});await study.sync();this.refresh();wx.showToast({title:'同步完成',icon:'success'});}catch(err){api.error(err);}finally{wx.hideLoading();}},
  login(){wx.navigateTo({url:'/pages/auth/index'});},teacher(){wx.navigateTo({url:'/pages/teacher/index'});},notices(){wx.navigateTo({url:'/pages/notices/index'});},privacy(){wx.navigateTo({url:'/pages/privacy/index'});},
  async logout(){const res=await new Promise(resolve=>wx.showModal({title:'退出班级账号',content:'未同步的记录仍保存在本机当前账号下，下次绑定同一账号可继续同步。',success:resolve}));if(res.confirm){api.saveProfile(null);this.refresh();}},
  copyAccount(){if(this.data.profile)wx.setClipboardData({data:this.data.profile.id});}
});
