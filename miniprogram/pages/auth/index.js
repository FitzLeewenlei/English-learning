const api=require('../../utils/api');
Page({
  data:{role:'student',name:'',studentNo:'',code:'',agreed:false,busy:false,cloud:false},
  onLoad(){this.setData({cloud:api.enabled()});},
  chooseRole(e){this.setData({role:e.currentTarget.dataset.role,code:''});},
  input(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  agree(e){this.setData({agreed:e.detail.value.includes('agree')});},
  privacy(){wx.navigateTo({url:'/pages/privacy/index'});},
  async copyAccount(){try{const r=await api.call('me');wx.setClipboardData({data:r.accountId});if(r.profile)api.saveProfile(r.profile);}catch(err){api.error(err);}},
  async submit(){
    if(this.data.busy)return;
    if(!this.data.cloud){wx.showToast({title:'在线班级服务暂未开通，请联系管理员',icon:'none'});return;}
    if(!this.data.agreed){wx.showToast({title:'请先阅读并同意隐私与数据说明',icon:'none'});return;}
    const name=this.data.name.trim(),code=this.data.code.trim();
    if(!name||!code||(this.data.role==='student'&&!this.data.studentNo.trim())){wx.showToast({title:'请填写完整的身份信息',icon:'none'});return;}
    this.setData({busy:true});
    try{
      const result=await api.call(this.data.role==='student'?'registerStudent':'registerTeacher',{name,studentNo:this.data.studentNo.trim(),code,privacyVersion:'1.0'});
      api.saveProfile(result.profile);
      wx.showToast({title:this.data.role==='student'?'已提交入班申请':'教师身份已验证',icon:'success'});
      wx.switchTab({url:'/pages/profile/index'});
    }catch(err){api.error(err);}finally{this.setData({busy:false});}
  }
});
