const course=require('../data/course');
const resources=require('./resources');
const cache=new Map(),pending={};
let wordsCache=null;
function normalize(word){return String(word).toLowerCase().replace(/’/g,"'");}
function englishTokens(text){
  const pattern=/([A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*)/g;
  return String(text).split(pattern).filter(Boolean).map(text=>({text,word:/^[A-Za-z]+(?:[’'-][A-Za-z]+)*$|^\d+(?:,\d{3})*$/.test(text)}));
}
function tokens(text,annotations){
  const result=[];let cursor=0;
  (annotations||[]).forEach(note=>{result.push(...englishTokens(text.slice(cursor,note.start)));result.push({text:note.text,word:false,note:true});cursor=note.end;});
  result.push(...englishTokens(text.slice(cursor)));
  return result.map((token,index)=>({...token,key:index}));
}
async function loadUnit(number){
  const id=String(number),record=course.unitFiles[id];
  if(!record)throw new Error('这个单元尚未上架。');
  if(cache.has(id)){const b=cache.get(id);cache.delete(id);cache.set(id,b);return b;}
  if(!pending[id])pending[id]=resources.readJson(record).then(bundle=>{
    if(bundle.number!==Number(number)||!bundle.unit||!Array.isArray(bundle.unit.examples)||!bundle.dictionary||!bundle.timings)throw new Error('单元资料不完整，请联系老师。');
    const metadata=course.lists[id];
    const unit={id:Number(number),title:'Unit '+number,vocabulary:metadata.vocabulary,
      examples:bundle.unit.examples.map((e,i)=>({...e,id:'unit-'+number+'-example-'+(i+1),listId:Number(number)}))};
    const result={unit,dictionary:bundle.dictionary,timings:bundle.timings};
    cache.set(id,result);while(cache.size>6)cache.delete(cache.keys().next().value);
    return result;
  }).finally(()=>{delete pending[id];});
  return pending[id];
}
function getWord(word,listId){
  const b=cache.get(String(listId));const entry=b&&b.dictionary[normalize(word)]||{};
  const headword=entry.source&&entry.source.definition_scope==='returned_headword'?(entry.headword||entry.source.headword):(entry.lemma||(entry.source&&entry.source.lemma));
  return {word,ipa:entry.ipa||'有道音标暂缺',audio:entry.audio||'',
    senses:(entry.senses||[]).map(s=>({pos:s.pos,meaning:(s.meanings||[]).slice(0,2).join('；')})),
    headword:headword&&normalize(headword)!==normalize(word)?headword:'',sourceUrl:entry.source&&entry.source.url||'',
    status:entry.status||'unavailable'};
}
function getTimings(source,listId){const b=cache.get(String(listId));return b&&b.timings[source];}
function allWords(){if(wordsCache)return wordsCache;const seen={};wordsCache=Object.keys(course.lists).sort((a,b)=>Number(a)-Number(b)).reduce((out,id)=>out.concat(course.lists[id].vocabulary),[]).filter(w=>!seen[w.id]&&(seen[w.id]=true));return wordsCache;}
function focusPieces(text){
  const regex=/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
  const matches=[];let match;while((match=regex.exec(text)))matches.push({text:match[0],start:match.index,end:regex.lastIndex});
  return matches.map((m,i)=>{const next=matches[i+1];const fragment=text.slice(i===0?0:m.start,next?next.start:text.length);return {text:fragment.replace(/\s+$/,''),key:normalize(m.text),spaceAfter:/\s$/.test(fragment)};});
}
module.exports={course,normalize,tokens,loadUnit,getWord,getTimings,allWords,focusPieces};
