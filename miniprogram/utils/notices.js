const local = require('../data/notices');
const storage = require('./storage');
const api = require('./api');
function decorate(item, read) {
  return { ...item, read:Boolean(item.read||read[item.id]), dateLabel:new Date(item.createdAt).toLocaleDateString('zh-CN') };
}
async function getAll() {
  let list=local.slice();
  if(api.enabled()){
    try{const result=await api.call('listNotices');list=list.concat(result.notices||[]);storage.set('noticeCache',list,true);}
    catch(_){list=storage.get('noticeCache',list,true);}
  }
  const seen={},read=storage.get('readNotices',{},true);
  return list.filter(n=>!seen[n.id]&&(seen[n.id]=true)).sort((a,b)=>b.createdAt-a.createdAt).map(n=>decorate(n,read));
}
async function markRead(id) {
  const read=storage.get('readNotices',{},true);read[id]=Date.now();storage.set('readNotices',read,true);
  if(api.enabled())try{await api.call('markNoticeRead',{id});}catch(_){}
}
module.exports={getAll,markRead};
