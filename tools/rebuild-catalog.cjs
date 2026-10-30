const fs=require('fs'),path=require('path');const root=path.resolve(__dirname,'..');
const course=require('../miniprogram/data/course');const unique={};
Object.keys(course.lists).forEach(id=>course.lists[id].vocabulary.forEach(w=>{if(!unique[w.id])unique[w.id]={id:w.id,word:w.word,listId:Number(id),listIds:[]};unique[w.id].listIds.push(Number(id));}));
fs.writeFileSync(path.join(root,'cloudfunctions/learning/catalog.json'),JSON.stringify({words:Object.values(unique),listIds:Object.keys(course.lists).map(Number)})+'\n');
fs.copyFileSync(path.join(root,'miniprogram/utils/srs.js'),path.join(root,'cloudfunctions/learning/srs.js'));
console.log('云端词表已更新：'+Object.keys(unique).length+' 张记忆卡。');
