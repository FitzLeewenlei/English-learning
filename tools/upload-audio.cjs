// Default is a read-only plan. Credentials are read from environment variables only.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const manifest=require('../audio-resource-manifest.json');
async function main(){
  if(!process.argv.includes('--upload')){console.log(JSON.stringify({mode:'dry-run',files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0),instructions:'Set TCB_ENV_ID, TCB_SECRET_ID and TCB_SECRET_KEY, install @cloudbase/node-sdk, then run node tools/upload-audio.cjs --upload.'},null,2));return;}
  const env=process.env.TCB_ENV_ID,secretId=process.env.TCB_SECRET_ID,secretKey=process.env.TCB_SECRET_KEY;
  if(!env||!secretId||!secretKey)throw new Error('Missing cloud credentials in environment variables. Never put them in client config or git.');
  const cloudbase=require('@cloudbase/node-sdk');const app=cloudbase.init({env,secretId,secretKey});
  const receiptPath=path.join(root,'cloud-audio-upload.local.json');let saved={env,files:{}};
  if(fs.existsSync(receiptPath)){const prior=JSON.parse(fs.readFileSync(receiptPath,'utf8'));if(prior.env===env)saved=prior;}
  let cursor=0,done=0,rootId='';const errors=[];
  async function worker(){for(;;){const index=cursor++;if(index>=manifest.files.length)return;const file=manifest.files[index];
    if(saved.files[file.path]&&saved.files[file.path].sha256===file.sha256){done++;continue;}
    let last;for(let attempt=0;attempt<3;attempt++){try{const result=await app.uploadFile({cloudPath:file.path,fileContent:fs.createReadStream(path.join(root,'audio-resources',file.path))});if(!result.fileID)throw new Error('No fileID returned');saved.files[file.path]={fileID:result.fileID,sha256:file.sha256};rootId=result.fileID.split('/audio/')[0];fs.writeFileSync(receiptPath,JSON.stringify(saved,null,2));done++;last=null;break;}catch(err){last=err;}}
    if(last)errors.push({path:file.path,message:last.message});if(done%100===0)console.log('Uploaded or resumed '+done+' / '+manifest.files.length);
  }}
  await Promise.all([worker(),worker(),worker()]);
  console.log(JSON.stringify({uploaded:done,failed:errors.length,audioCloudRoot:rootId,errors},null,2));
  if(errors.length)process.exitCode=1;
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
