'use strict';
const cloud=require('wx-server-sdk');
const crypto=require('crypto');
const {createService}=require('./core');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const COLLECTIONS=['users','classes','classCodes','teacherInvites','studentClaims','progress','studyEvents','dailyStats','notices','readReceipts'];
function conditions(filter){
  const out={};Object.keys(filter||{}).forEach(key=>{
    const value=filter[key];
    out[key]=value&&value.contains?db.command.all([value.contains]):value&&value.gt!==undefined?db.command.gt(value.gt):value;
  });return out;
}
function adapter(database){
  return {
    async get(collection,id){try{const r=await database.collection(collection).doc(id).get();if(!r.data)return null;const {_id,...data}=r.data;return data;}catch(err){if(/not.exist|does.not.exist|不存在|DOCUMENT_NOT_FOUND/i.test(err.errMsg||err.message||''))return null;throw err;}},
    async set(collection,id,data){await database.collection(collection).doc(id).set({data});},
    async remove(collection,id){await database.collection(collection).doc(id).remove();},
    async query(collection,filter,options){const opt=options||{};let q=database.collection(collection).where(conditions(filter));if(opt.order)q=q.orderBy(opt.order,opt.desc?'desc':'asc');q=q.skip(opt.offset||0).limit(opt.limit||100);const r=await q.get();return r.data.map(({_id,...data})=>({id:_id,...data}));},
    async count(collection,filter){const r=await database.collection(collection).where(conditions(filter)).count();return r.total;},
    async transaction(fn){return db.runTransaction(async tx=>fn(adapter(tx)));}
  };
}
let initialized=false;
async function initialize(){
  if(initialized)return;
  for(const name of COLLECTIONS){try{await db.createCollection(name);}catch(err){if(!/exist|已存在/i.test(err.errMsg||err.message||''))throw err;}}
  initialized=true;
}
exports.main=async(event)=>{
  const openid=cloud.getWXContext().OPENID;
  if(!openid)return {ok:false,message:'未取得微信身份，请从小程序内重试。'};
  const uid=crypto.createHash('sha256').update(openid).digest('hex').slice(0,32);
  const admins=(process.env.ADMIN_ACCOUNT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  try{
    if(admins.includes(uid))await initialize();
    const service=createService(adapter(db),{adminIds:admins});
    const data=await service.handle(uid,event.action,event.payload||{});
    return {ok:true,data};
  }catch(err){
    console.error('Learning request failed',{action:event.action,message:err.message});
    return {ok:false,message:err.publicMessage||'服务暂不可用，请稍后重试或联系管理员完成开通。'};
  }
};
