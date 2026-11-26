// Offline tests for a fresh GitHub checkout. No model key, login or runtime download required.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process')
const root=path.resolve(__dirname,'..'),source=path.join(root,'app-source'),stage=path.join(root,'staging','P2-18.1','app')
function copy(src,dest){const st=fs.statSync(src);if(st.isDirectory()){fs.mkdirSync(dest,{recursive:true});for(const name of fs.readdirSync(src))copy(path.join(src,name),path.join(dest,name))}else{fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest)}}
for(const name of ['electron','dist','package.json'])copy(path.join(source,name),path.join(stage,name))
const artifacts=path.join(root,'test-artifacts');fs.mkdirSync(artifacts,{recursive:true});const temp=path.join(artifacts,'tmp');fs.mkdirSync(temp,{recursive:true})
const files=fs.readdirSync(path.join(source,'tests')).filter(n=>n.endsWith('.test.cjs')).sort().map(n=>path.join(source,'tests',n))
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{cwd:source,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024,env:{...process.env,TEMP:temp,TMP:temp,NODE_OPTIONS:'',DOUYIN_ASSISTANT_DATA_DIR:path.join(artifacts,'isolated-data')}})
const output=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(path.join(artifacts,'results.tap'),output)
console.log(output.split(/\r?\n/).slice(-12).join('\n'))
if(result.status!==0){console.error('Full log: '+path.join(artifacts,'results.tap'));console.error(output.split(/\r?\n/).filter((line,i,rows)=>line.startsWith('not ok ')).join('\n'))}
process.exitCode=result.status===0?0:1
