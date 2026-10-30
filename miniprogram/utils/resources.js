const requests={};
function resourceError(message,code,record,cause){
  const error=new Error(message);error.code=code;
  error.package=record.package;error.filePath=record.path;error.cause=cause;
  return error;
}
function loadPackage(name){
  if(requests[name])return requests[name];
  if(typeof wx.loadSubpackage!=='function')return Promise.reject(new Error('当前微信版本不支持课程分包，请更新微信。'));
  requests[name]=new Promise((resolve,reject)=>wx.loadSubpackage({name,success:resolve,fail:reject})).catch(cause=>{
    delete requests[name];
    throw resourceError('课程分包下载失败，请检查网络后重试。','PACKAGE_DOWNLOAD',{package:name},cause);
  });
  return requests[name];
}
function readJson(record){
  return loadPackage(record.package).then(()=>new Promise((resolve,reject)=>{
    // Course JSON is stored as a plain text resource. Mini-program .json files
    // are compiler configuration, not general-purpose files in the runtime package.
    const filePath='/'+record.path.replace(/^\/+/, '');
    wx.getFileSystemManager().readFile({filePath,encoding:'utf8',success:result=>{
      try{resolve(JSON.parse(result.data));}catch(cause){reject(resourceError('课程文件损坏，请重新下载完整工程。','COURSE_PARSE',record,cause));}
    },fail:cause=>reject(resourceError('课程文件读取失败，请重新下载完整工程，清除缓存后编译。','COURSE_FILE',record,cause))});
  }));
}
module.exports={loadPackage,readJson};
