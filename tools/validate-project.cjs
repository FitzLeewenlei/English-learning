const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),assert=require('assert');
const root=path.resolve(__dirname,'..'),mini=path.join(root,'miniprogram');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).filter(e=>!['node_modules','.git','__pycache__'].includes(e.name)).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
let scripts=0,json=0;
for(const file of walk(root)){if(/\.(js|cjs)$/.test(file)){new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});scripts++;}if(file.endsWith('.json')){JSON.parse(fs.readFileSync(file,'utf8'));json++;}}
const app=require(path.join(mini,'app.json')),course=require(path.join(mini,'data/course'));
const routes=app.pages.concat(...app.subpackages.map(p=>p.pages.map(page=>p.root+'/'+page)));
routes.forEach(route=>['.js','.json','.wxml','.wxss'].forEach(ext=>assert(fs.existsSync(path.join(mini,route+ext)),route+ext+' missing')));
const provenance=require(path.join(root,'course-sources/unit-provenance.json'));
const assets=require(path.join(root,'audio-resource-manifest.json'));
const manifest=require(path.join(mini,'data/audio-manifest'));
const normalize=t=>String(t).toLowerCase().replace(/’/g,"'");
let entries=0,examples=0,annotations=0,alignmentTokens=0;
const dictionaries=new Set(),usedAudio=new Set(),cards=new Set();
for(const record of provenance){
  const raw=fs.readFileSync(path.join(mini,record.runtimePath));
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),record.sha256,'Unit byte mismatch '+record.unit);
  const bundle=JSON.parse(raw),metadata=course.lists[record.unit].vocabulary;
  assert.equal(bundle.number,record.unit);assert.equal(bundle.unit.vocabulary.length,15);assert.equal(bundle.unit.examples.length,15);
  entries+=metadata.length;examples+=bundle.unit.examples.length;
  bundle.unit.vocabulary.forEach((w,i)=>{const m=metadata[i];for(const key of ['word','ipa','partsOfSpeech','meaning'])assert.equal(m[key],w[key],'Vocabulary changed '+record.unit+' '+key);assert.equal(m.audio,bundle.dictionary[normalize(w.word)].audio);cards.add(m.id);usedAudio.add(m.audio);});
  Object.entries(bundle.dictionary).forEach(([key,d])=>{dictionaries.add(key);if(d.audio)usedAudio.add(d.audio);});
  bundle.unit.examples.forEach(e=>{
    assert(e.source,'Missing original source '+record.unit);assert(e.speechText);usedAudio.add(e.audio);annotations+=(e.annotations||[]).length;
    for(const note of e.annotations||[])assert.equal(e.text.slice(note.start,note.end),note.text,'Annotation offset changed');
    const timing=bundle.timings[e.audio];assert(timing,'Missing word timing '+record.unit);
    const rawAudio=fs.readFileSync(path.join(root,'audio-resources',e.audio));assert.equal(crypto.createHash('sha256').update(rawAudio).digest('hex'),timing.sha256);
    const tokens=(e.speechText.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g)||[]).map(normalize);
    assert.deepEqual(timing.words.map(w=>normalize(w.text)),tokens,'Subtitle token mismatch '+record.unit+' '+e.audio);alignmentTokens+=tokens.length;
  });
}
assert.equal(provenance.length,120);assert.equal(entries,1800);assert.equal(examples,1800);
const assetPaths=new Set();
for(const item of assets.files){const bytes=fs.readFileSync(path.join(root,'audio-resources',item.path));assert.equal(bytes.length,item.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256,'Audio checksum mismatch '+item.path);assetPaths.add(item.path);}
assert.deepEqual([...usedAudio].sort(),[...assetPaths].sort(),'Referenced audio archive mismatch');
for(const [source,record] of Object.entries(manifest)){const bytes=fs.readFileSync(path.join(mini,record.path));assert.equal(bytes.length,record.bytes);assert(bytes.equals(fs.readFileSync(path.join(root,'audio-resources',source))));}
const packages={};for(const p of app.subpackages){const bytes=walk(path.join(mini,p.root)).reduce((n,f)=>n+fs.statSync(f).size,0);assert(bytes<2*1024*1024,p.root+' exceeds 2MiB');packages[p.root]=bytes;}
const subdirs=app.subpackages.map(p=>path.join(mini,p.root)+path.sep);
const mainBytes=walk(mini).filter(f=>!subdirs.some(d=>f.startsWith(d))).reduce((n,f)=>n+fs.statSync(f).size,0);
assert(mainBytes<2*1024*1024,'Main package exceeds 2MiB');const total=mainBytes+Object.values(packages).reduce((a,b)=>a+b,0);assert(total<20*1024*1024,'Conservative 20MiB project budget exceeded');
assert(fs.readFileSync(path.join(mini,'utils/srs.js')).equals(fs.readFileSync(path.join(root,'cloudfunctions/learning/srs.js'))));
const server=require(path.join(root,'cloudfunctions/learning/catalog.json'));assert.equal(new Set(server.words.map(w=>w.id)).size,cards.size);
console.log(JSON.stringify({scripts,json,routes:routes.length,units:120,vocabularyEntries:entries,examples,learningCards:cards.size,dictionaryForms:dictionaries.size,annotations,alignmentTokens,audioFiles:assets.files.length,audioBytes:assets.files.reduce((n,a)=>n+a.bytes,0),mainBytes,subpackageBytes:packages,totalPackageBytes:total},null,2));
