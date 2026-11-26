const test=require('node:test'),assert=require('node:assert/strict')
const {createMemoryStorage}=require('./setup.cjs')
const {DiscoveryEngine}=require('../electron/discovery/discovery-engine.cjs')
const fixture=()=>new DiscoveryEngine({storage:createMemoryStorage()},{accountId:'fixture'})
test('candidate inspection reads an available main frame while wrapper waits for unrelated resources',async()=>{
 const engine=fixture()
 const win={webContents:{executeJavaScript:()=>assert.fail('The wrapper would wait for did-stop-loading'),mainFrame:{executeJavaScript:async()=>({ready:true,platformUserId:'target'})}}}
 const out=await engine.waitSnapshot(win,()=>{},[],engine.generation)
 assert.equal(out.platformUserId,'target')
})
test('a truly unresponsive main frame is bounded by the inspection deadline',async()=>{
 const engine=fixture(),win={show(){},webContents:{mainFrame:{executeJavaScript:()=>new Promise(()=>{})}}}
 await assert.rejects(engine.waitSnapshot(win,()=>{},[],engine.generation,undefined,{timeout:20,interval:1}),/未读到可靠|读取超时/)
})
test('navigation context replacement may retry but an account change never accepts the late profile',async()=>{
 const engine=fixture();let calls=0
 const win={webContents:{mainFrame:{executeJavaScript:async()=>{if(++calls===1)throw Error('context replaced');return {ready:true}}}}}
 assert.equal((await engine.waitSnapshot(win,()=>{},[],engine.generation,undefined,{timeout:100,interval:1})).ready,true)
 win.webContents.mainFrame.executeJavaScript=async()=>{engine.generation++;return {ready:true}}
 await assert.rejects(engine.waitSnapshot(win,()=>{},[],engine.generation),/已停止/)
})
test('main-frame inspection preserves visible verification and target-identity failure',async()=>{
 for(const value of [{challenge:true},{wrongPage:true}]){
  const engine=fixture(),win={show(){},webContents:{mainFrame:{executeJavaScript:async()=>value}}}
  await assert.rejects(engine.waitSnapshot(win,()=>{},[],engine.generation),value.challenge?/安全验证/:/其他视频或主页/)
 }
})
