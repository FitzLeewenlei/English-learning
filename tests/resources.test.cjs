const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../miniprogram');
const calls={},loaded=new Set();
let failNext=false,readMode='normal';
global.wx={
  loadSubpackage({name,success,fail}){
    calls[name]=(calls[name]||0)+1;
    if(failNext){failNext=false;return fail({errMsg:'loadSubpackage:fail test network'});}
    queueMicrotask(()=>{loaded.add(name);success({});});
  },
  getFileSystemManager:()=>({readFile({filePath,encoding,success,fail}){
    if(readMode==='missing')return fail({errMsg:'readFile:fail no such file'});
    if(readMode==='corrupt')return success({data:'{invalid'});
    const relative=filePath.replace(/^\//,'');
    // Model the compiled package rather than treating the source checkout as
    // an unrestricted filesystem: .json is configuration, not a raw resource.
    if(!loaded.has(relative.split('/')[0])||relative.endsWith('.json'))return fail({errMsg:'readFile:fail resource unavailable'});
    try{success({data:fs.readFileSync(path.join(root,relative),encoding)});}catch(error){fail(error);}
  }})
};
const resources=require('../miniprogram/utils/resources'),catalog=require('../miniprogram/utils/course');
test('All 120 units load using packaged text resources, without reading compiler JSON',async()=>{
  for(let number=1;number<=120;number++){
    const bundle=await catalog.loadUnit(number);
    assert.equal(bundle.unit.id,number);
    assert.equal(bundle.unit.vocabulary.length,15);
    assert.equal(bundle.unit.examples.length,15);
    assert(Object.keys(bundle.dictionary).length>0);
  }
  for(let n=1;n<=8;n++)assert.equal(calls['unitdata'+n],1);
});
test('A failed package download can be retried, including a synchronous API failure',async()=>{
  failNext=true;
  await assert.rejects(resources.loadPackage('retry-package'),error=>error.code==='PACKAGE_DOWNLOAD');
  await resources.loadPackage('retry-package');
  assert.equal(calls['retry-package'],2);
});
test('Missing and corrupt course resources report actionable errors rather than a network error',async()=>{
  const record=catalog.course.unitFiles[1];
  readMode='missing';
  await assert.rejects(resources.readJson(record),error=>error.code==='COURSE_FILE'&&error.filePath===record.path&&!error.message.includes('网络'));
  readMode='corrupt';
  await assert.rejects(resources.readJson(record),error=>error.code==='COURSE_PARSE');
  readMode='normal';
  assert.equal((await resources.readJson(record)).number,1);
});
