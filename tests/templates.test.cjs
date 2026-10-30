const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const compiler=require('miniprogram-compiler');
const root=path.resolve(__dirname,'../miniprogram');
test('Every WXML template compiles with the official wcc compiler',()=>{const result=compiler.wxmlToJs(root);assert(result.length>1000);});
test('Every WXSS stylesheet compiles with the official wcsc compiler',()=>{const result=compiler.wxssToJs(root);assert(result.length>1000);});
test('Project routes, audio copies, alignment checksums and package sizes validate',()=>{const result=require('node:child_process').spawnSync(process.execPath,[path.resolve(__dirname,'../tools/validate-project.cjs')],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);});
