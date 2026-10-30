const api=require('../../utils/api');
Page({
  data:{profile:null,allowed:false,loading:true,classes:[],classIndex:0,classId:'',students:[],pending:[],
    total:0,activeToday:0,hasMore:false,noticeTitle:'',noticeBody:'',className:'',classCode:'',invite:'',busy:false},
  onShow(){this.load();},onPullDownRefresh(){this.load().finally(()=>wx.stopPullDownRefresh());},
  async load(){
    this.setData({loading:true});
    try{
      if(!api.enabled()){this.setData({allowed:false});return;}
      const profile=await api.refreshProfile();
      if(!profile||!['teacher','admin'].includes(profile.role)){this.setData({allowed:false});return;}
      this.setData({allowed:true,profile});
      const result=await api.call('myClasses');
      const index=Math.max(0,result.classes.findIndex(c=>c.id===this.data.classId));
      this.setData({classes:result.classes,classIndex:index,classId:result.classes[index]?result.classes[index].id:''});
      if(this.data.classId)await this.loadStudents(false);else this.setData({students:[],pending:[],total:0,activeToday:0});
    }catch(err){api.error(err);}finally{this.setData({loading:false});}
  },
  async loadStudents(append){
    const result=await api.call('teacherSummary',{classId:this.data.classId,offset:append?this.data.students.length:0});
    this.setData({students:append?this.data.students.concat(result.students):result.students,pending:result.pending,
      total:result.total,activeToday:result.activeToday,hasMore:result.hasMore,classCode:result.classCode||''});
  },
  async changeClass(e){this.setData({classIndex:Number(e.detail.value),classId:this.data.classes[Number(e.detail.value)].id});try{await this.loadStudents(false);}catch(err){api.error(err);}},
  async more(){try{await this.loadStudents(true);}catch(err){api.error(err);}},
  detail(e){wx.navigateTo({url:'/pages/student/index?id='+encodeURIComponent(e.currentTarget.dataset.id)+'&classId='+encodeURIComponent(this.data.classId)});},
  async approve(e){try{await api.call('approveStudent',{studentId:e.currentTarget.dataset.id,classId:this.data.classId,approve:e.currentTarget.dataset.approve==='yes'});await this.loadStudents(false);}catch(err){api.error(err);}},
  input(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  async createClass(){if(this.data.busy)return;this.setData({busy:true});try{const r=await api.call('createClass',{name:this.data.className.trim()});this.setData({classId:r.classId,className:''});wx.setClipboardData({data:r.code});await this.load();}catch(err){api.error(err);}finally{this.setData({busy:false});}},
  copyCode(){wx.setClipboardData({data:this.data.classCode});},
  async inviteTeacher(){try{const r=await api.call('createTeacherInvite',{classId:this.data.classId});this.setData({invite:r.code});wx.setClipboardData({data:r.code});}catch(err){api.error(err);}},
  async publish(){if(this.data.busy)return;this.setData({busy:true});try{await api.call('publishNotice',{classId:this.data.classId,title:this.data.noticeTitle.trim(),body:this.data.noticeBody.trim()});this.setData({noticeTitle:'',noticeBody:''});wx.showToast({title:'班级通知已发布',icon:'success'});}catch(err){api.error(err);}finally{this.setData({busy:false});}},
  login(){wx.navigateTo({url:'/pages/auth/index'});}
});
