const requests={};
function loadPackage(name){
  if(requests[name])return requests[name];
  requests[name]=new Promise((resolve,reject)=>wx.loadSubpackage({name,success:resolve,fail:err=>{delete requests[name];reject(err);}}));
  return requests[name];
}
function readJson(record){
  return loadPackage(record.package).then(()=>new Promise((resolve,reject)=>{
    wx.getFileSystemManager().readFile({filePath:record.path,encoding:'utf8',success:result=>{
      try{resolve(JSON.parse(result.data));}catch(err){reject(new Error('单元资料读取失败，请重新进入。'));}
    },fail:reject});
  }));
}
module.exports={loadPackage,readJson};
