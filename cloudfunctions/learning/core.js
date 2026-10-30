'use strict';
const crypto=require('crypto');
const srs=require('./srs');
const catalog=require('./catalog.json');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,32);
const idFor=(uid,word)=>uid+'_'+hash(word);
const safe=value=>String(value===undefined?'':value).trim();
function fail(message){const err=new Error(message);err.publicMessage=message;throw err;}
function validText(value,min,max,label){const text=safe(value);if(text.length<min||text.length>max)fail(label+'长度不符合要求。');return text;}
function stamp(ms){if(!ms)return '尚无已同步练习';const d=new Date(ms+8*3600000);return '最近练习 '+d.toISOString().slice(0,16).replace('T',' ');}
async function all(repo,collection,filter){let rows=[],offset=0;for(;;){const next=await repo.query(collection,filter,{offset,limit:100});rows=rows.concat(next);if(next.length<100)return rows;offset+=100;if(offset>50000)fail('记录过多，请联系管理员分批处理。');}}
function createService(repo,options){
  const settings=options||{},now=()=>settings.now?settings.now():Date.now();
  const words=new Map(catalog.words.map(w=>[w.id,w]));
  const isAdmin=uid=>(settings.adminIds||[]).includes(uid);
  async function user(uid){return repo.get('users',uid);}
  async function teacher(uid){const u=await user(uid);if(!isAdmin(uid)&&(!u||u.role!=='teacher'||u.status!=='active'))fail('教师身份未验证，无法查看班级。');return u;}
  async function ownedClass(uid,classId){await teacher(uid);const c=await repo.get('classes',safe(classId));if(!c||(!isAdmin(uid)&&!(c.teacherIds||[]).includes(uid)))fail('你没有这个班级的访问权限。');return c;}
  async function profile(uid,u){
    if(!u)return null;
    if(u.role==='admin'&&!isAdmin(uid))return null;
    const c=u.classId?await repo.get('classes',u.classId):null;
    return {id:uid,name:u.name,role:isAdmin(uid)?'admin':u.role,status:u.status,classId:u.classId||'',className:c?c.name:''};
  }
  async function myClasses(uid){await teacher(uid);return all(repo,'classes',isAdmin(uid)?{}:{teacherIds:{contains:uid}});}
  async function canReadNotice(uid,n){
    if(!n||n.published===false)return false;if(!n.classId)return true;
    if(isAdmin(uid))return true;
    const u=await user(uid);if(!u)return false;
    if(u.role==='student')return u.status==='active'&&u.classId===n.classId;
    if(u.role==='teacher'){const c=await repo.get('classes',n.classId);return c&&(c.teacherIds||[]).includes(uid);}
    return false;
  }
  const actions={
    async me(uid){
      let u=await user(uid);
      if(isAdmin(uid)&&(!u||u.role!=='admin')){u={name:u?u.name:'校区管理员',role:'admin',status:'active',createdAt:now(),privacyVersion:'1.0'};await repo.set('users',uid,u);}
      return {accountId:uid,profile:await profile(uid,u)};
    },
    async registerStudent(uid,p){
      const name=validText(p.name,1,30,'姓名'),studentNo=validText(p.studentNo,1,40,'学生编号');
      const code=validText(p.code,4,32,'班级码').toUpperCase();
      if(p.privacyVersion!=='1.0')fail('请先阅读隐私与数据说明。');
      await repo.transaction(async tx=>{
        const old=await tx.get('users',uid);if(old&&old.status!=='rejected')fail('当前微信账号已绑定身份，请先联系管理员调整。');
        if(isAdmin(uid))fail('管理员账号不能绑定为学生。');
        const link=await tx.get('classCodes',hash(code));if(!link||!link.active)fail('班级码无效，请向老师确认。');
        const c=await tx.get('classes',link.classId);if(!c)fail('班级已停用。');
        const claimId=link.classId+'_'+hash(studentNo);
        const claim=await tx.get('studentClaims',claimId);if(claim&&claim.userId!==uid)fail('该学生编号已申请入班，请联系老师核对。');
        await tx.set('studentClaims',claimId,{userId:uid,classId:link.classId,studentNo});
        await tx.set('users',uid,{name,studentNo,classId:link.classId,role:'student',status:'pending',createdAt:now(),privacyVersion:'1.0'});
      });
      return {profile:await profile(uid,await user(uid))};
    },
    async registerTeacher(uid,p){
      const name=validText(p.name,1,30,'姓名'),code=validText(p.code,8,32,'教师邀请码').toUpperCase();
      if(p.privacyVersion!=='1.0')fail('请先阅读隐私与数据说明。');
      await repo.transaction(async tx=>{
        if(await tx.get('users',uid))fail('当前微信账号已绑定身份，请联系管理员处理。');
        const invite=await tx.get('teacherInvites',hash(code));
        if(!invite||invite.usedBy||invite.expiresAt<now())fail('教师邀请码无效、已使用或已过期。');
        const c=await tx.get('classes',invite.classId);if(!c)fail('邀请码所属班级已停用。');
        await tx.set('teacherInvites',hash(code),{...invite,usedBy:uid,usedAt:now()});
        await tx.set('classes',invite.classId,{...c,teacherIds:Array.from(new Set((c.teacherIds||[]).concat(uid)))});
        await tx.set('users',uid,{name,role:'teacher',status:'active',createdAt:now(),privacyVersion:'1.0'});
      });return {profile:await profile(uid,await user(uid))};
    },
    async createClass(uid,p){
      await teacher(uid);const name=validText(p.name,1,50,'班级名称');
      const code=crypto.randomBytes(5).toString('hex').toUpperCase(),classId='c_'+crypto.randomBytes(10).toString('hex');
      await repo.transaction(async tx=>{await tx.set('classes',classId,{name,teacherIds:[uid],code,createdAt:now()});await tx.set('classCodes',hash(code),{classId,active:true});});
      return {classId,code};
    },
    async createTeacherInvite(uid,p){
      if(!isAdmin(uid))fail('只有管理员可以开通教师权限。');await ownedClass(uid,p.classId);
      const code=crypto.randomBytes(8).toString('hex').toUpperCase();await repo.set('teacherInvites',hash(code),{classId:p.classId,createdAt:now(),expiresAt:now()+7*srs.DAY,createdBy:uid});return {code};
    },
    async myClasses(uid){return {classes:await myClasses(uid)};},
    async approveStudent(uid,p){
      await ownedClass(uid,p.classId);
      await repo.transaction(async tx=>{const u=await tx.get('users',safe(p.studentId));if(!u||u.role!=='student'||u.classId!==p.classId||u.status!=='pending')fail('这条入班申请不存在或已处理。');
        await tx.set('users',p.studentId,{...u,status:p.approve===true?'active':'rejected',approvedBy:uid,approvedAt:now()});
        if(p.approve===true){const dailyId=p.studentId+'_'+srs.dateKey(now());const daily=await tx.get('dailyStats',dailyId);if(daily)await tx.set('dailyStats',dailyId,{...daily,classId:p.classId});}
        if(p.approve!==true)await tx.remove('studentClaims',p.classId+'_'+hash(u.studentNo));
      });return {success:true};
    },
    async teacherSummary(uid,p){
      const c=await ownedClass(uid,p.classId),offset=Math.max(0,Math.min(50000,Number(p.offset)||0));
      const total=await repo.count('users',{classId:p.classId,role:'student',status:'active'});
      const rows=await repo.query('users',{classId:p.classId,role:'student',status:'active'},{offset,limit:50});
      const day=srs.dateKey(now());
      const students=await Promise.all(rows.map(async u=>{const d=await repo.get('dailyStats',u.id+'_'+day)||{};return {id:u.id,name:u.name,studentNo:u.studentNo,newToday:(d.newWordIds||[]).length,reviewToday:(d.reviewWordIds||[]).length,practiceCount:d.practiceCount||0,lastSeenLabel:stamp(d.lastEventAt||u.lastStudyAt)};}));
      const pending=(await repo.query('users',{classId:p.classId,role:'student',status:'pending'},{limit:100})).map(u=>({id:u.id,name:u.name,studentNo:u.studentNo}));
      const activeToday=await repo.count('dailyStats',{classId:p.classId,day,practiceCount:{gt:0}});
      return {students,pending,total,activeToday,hasMore:offset+rows.length<total,classCode:c.code};
    },
    async studentDetails(uid,p){
      const c=await ownedClass(uid,p.classId),u=await user(safe(p.studentId));
      if(!u||u.role!=='student'||u.status!=='active'||u.classId!==p.classId)fail('无法读取这位学生的记录。');
      const rows=(await all(repo,'progress',{userId:p.studentId})).filter(w=>words.has(w.wordId));
      const d=await repo.get('dailyStats',p.studentId+'_'+srs.dateKey(now()))||{};
      return {student:{name:u.name,studentNo:u.studentNo,className:c.name},words:rows.map(({id,userId,classId,...rest})=>rest),stats:{learned:rows.length,due:rows.filter(w=>w.dueAt<=now()).length,dictationCorrect:d.dictationCorrect||0,dictationCount:d.dictationCount||0}};
    },
    async myProgress(uid){const u=await user(uid);if(!u||u.role!=='student'||u.status==='rejected')fail('请先绑定学生账号。');const rows=await all(repo,'progress',{userId:uid});const progress={};rows.forEach(({id,userId,classId,...w})=>{progress[w.wordId]=w;});return {progress};},
    async syncStudy(uid,p){
      const u=await user(uid);if(!u||u.role!=='student'||u.status==='rejected')fail('请先绑定学生账号。');
      if(!Array.isArray(p.events)||p.events.length>40)fail('同步批次无效。');
      const events=p.events.map(e=>{
        if(!e||!words.has(e.wordId)||!['again','hard','good'].includes(e.rating)||!/^[a-z0-9-]{5,70}$/i.test(e.id||''))fail('练习记录格式无效，请更新小程序。');
        if(!Number.isFinite(e.at)||e.at>now()+5*60000||e.at<now()-45*srs.DAY)fail('练习记录时间异常，请校准手机时间或联系管理员。');
        const word=words.get(e.wordId);if(!(word.listIds||[word.listId]).includes(e.listId))fail('单词所属词书不匹配。');
        return {...e,mode:e.mode==='dictation'?'dictation':'recall'};
      }).sort((a,b)=>a.at-b.at);
      for(const e of events)await repo.transaction(async tx=>{
        const eventId=uid+'_'+hash(e.id);if(await tx.get('studyEvents',eventId))return;
        const old=await tx.get('progress',idFor(uid,e.wordId));
        const next=!old||e.at>old.lastReviewedAt?srs.nextReview(old,e.rating,e.at):old;
        await tx.set('progress',idFor(uid,e.wordId),{...next,wordId:e.wordId,listId:e.listId,userId:uid,classId:u.status==='active'?u.classId:''});
        const day=srs.dateKey(e.at),dailyId=uid+'_'+day;
        const d=await tx.get('dailyStats',dailyId)||{newWordIds:[],reviewWordIds:[],practiceCount:0,dictationCount:0,dictationCorrect:0};
        const isNew=!old||srs.dateKey(old.firstLearnedAt)===day;
        const field=isNew?'newWordIds':'reviewWordIds';d[field]=Array.from(new Set((d[field]||[]).concat(e.wordId)));
        await tx.set('dailyStats',dailyId,{...d,userId:uid,classId:u.status==='active'?u.classId:'',day,practiceCount:(d.practiceCount||0)+1,lastEventAt:Math.max(d.lastEventAt||0,e.at),dailyGoal:Math.max(1,Math.min(100,Number(p.dailyGoal)||15)),dictationCount:(d.dictationCount||0)+(e.mode==='dictation'?1:0),dictationCorrect:(d.dictationCorrect||0)+(e.mode==='dictation'&&e.answerCorrect===true?1:0)});
        await tx.set('studyEvents',eventId,{userId:uid,wordId:e.wordId,rating:e.rating,at:e.at,receivedAt:now(),mode:e.mode});
      });
      const refreshed=await user(uid);await repo.set('users',uid,{...refreshed,lastStudyAt:Math.max(refreshed.lastStudyAt||0,...events.map(e=>e.at)),lastSyncedAt:now()});
      return {accepted:events.length,serverTime:now()};
    },
    async publishNotice(uid,p){
      const classId=safe(p.classId);if(classId)await ownedClass(uid,classId);else if(!isAdmin(uid))fail('只有管理员可以发布全校通知。');
      const title=validText(p.title,1,80,'通知标题'),body=validText(p.body,1,3000,'通知正文');
      const id='n_'+crypto.randomBytes(12).toString('hex');await repo.set('notices',id,{classId,title,body,published:true,popup:true,createdBy:uid,createdAt:now()});return {id};
    },
    async listNotices(uid){
      const u=await user(uid);let classIds=[''];
      if(isAdmin(uid))classIds=classIds.concat((await myClasses(uid)).map(c=>c.id));
      else if(u&&u.role==='teacher')classIds=classIds.concat((await myClasses(uid)).map(c=>c.id));
      else if(u&&u.role==='student'&&u.status==='active')classIds.push(u.classId);
      const groups=await Promise.all(classIds.map(classId=>repo.query('notices',{classId,published:true},{order:'createdAt',desc:true,limit:100})));
      const rows=groups.reduce((a,b)=>a.concat(b),[]).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100);
      return {notices:await Promise.all(rows.map(async n=>({id:n.id,title:n.title,body:n.body,createdAt:n.createdAt,popup:n.popup,read:Boolean(await repo.get('readReceipts',uid+'_'+hash(n.id)))})))};
    },
    async markNoticeRead(uid,p){const id=safe(p.id),n=await repo.get('notices',id);if(!await canReadNotice(uid,n))fail('这条通知不存在或无权查看。');await repo.set('readReceipts',uid+'_'+hash(id),{userId:uid,noticeId:id,readAt:now()});return {success:true};}
  };
  return {async handle(uid,action,payload){if(!/^[a-z0-9_:-]{1,100}$/i.test(uid))fail('账号标识无效。');if(!Object.prototype.hasOwnProperty.call(actions,action))fail('不支持的操作。');return actions[action](uid,payload||{});}};
}
module.exports={createService,hash};
