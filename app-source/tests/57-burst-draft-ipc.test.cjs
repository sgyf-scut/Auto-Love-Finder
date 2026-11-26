const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path')
const source=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8')
const begin=source.indexOf("ipcMain.handle('douyin:send-message'"),end=source.indexOf("ipcMain.handle('douyin:send-task'",begin)
function harness(){
  let state={pendingDrafts:[{id:'old',name:'虚拟朋友',status:'pending'},{id:'other',name:'另一虚拟朋友',status:'pending'}]},calls=[]
  const storage={get:()=>structuredClone(state),update:p=>state={...state,...p}}
  const entry={storage,douyin:{async confirmDraftFresh(id){const d=state.pendingDrafts.find(d=>d.id===id);if(!d||d.status==='outdated')throw new Error('BURST_STALE');return d},async sendMessage(name,text,metadata){calls.push({name,text,metadata});await metadata?.beforeSubmit?.();return {ok:true}}}}
  const handlers={},ctx={ipcMain:{handle:(key,fn)=>handlers[key]=fn},activeAccount:'A',getActiveServices:()=>entry,Error}
  vm.runInNewContext(source.slice(begin,end),ctx)
  return {handlers,ctx,entry,calls,get:()=>state,set:p=>state={...state,...p}}
}
test('ordinary draft IPC passes the draft identity and deletes only its current row after confirmed send',async()=>{
  const h=harness();h.entry.douyin.sendMessage=async(name,text,metadata)=>{h.calls.push({name,text,metadata});h.set({pendingDrafts:[...h.get().pendingDrafts,{id:'new',name:'虚拟朋友'}]});await metadata.beforeSubmit();return {ok:true}}
  await h.handlers['douyin:send-message'](null,{name:'虚拟朋友',text:'新回复',metadata:{draftId:'old'}})
  assert.equal(h.calls[0].metadata.draftId,'old');assert.equal(h.calls[0].metadata.ai,true)
  assert.deepEqual(h.get().pendingDrafts.map(d=>d.id),['other','new'])
})
test('outdated draft or mismatched contact never reaches outbound send',async()=>{
  const h=harness();h.set({pendingDrafts:h.get().pendingDrafts.map(d=>({...d,status:'outdated'}))})
  await assert.rejects(h.handlers['douyin:send-message'](null,{name:'虚拟朋友',text:'旧回复',metadata:{draftId:'old'}}),/STALE/)
  const second=harness();await assert.rejects(second.handlers['douyin:send-message'](null,{name:'错误朋友',text:'错目标',metadata:{draftId:'old'}}),/联系人/)
  assert.equal(h.calls.length+second.calls.length,0)
})
test('account switch before submit blocks an already approved ordinary draft',async()=>{
  const h=harness();h.entry.douyin.sendMessage=async(_name,_text,metadata)=>{h.ctx.activeAccount='B';await metadata.beforeSubmit();return {ok:true}}
  await assert.rejects(h.handlers['douyin:send-message'](null,{name:'虚拟朋友',text:'旧账号',metadata:{draftId:'old'}}),/账号已经切换/)
  assert.equal(h.get().pendingDrafts.length,2)
})
test('unconfirmed send retains draft and new backend messages',async()=>{
  const h=harness();h.entry.douyin.sendMessage=async()=>({ok:false})
  await assert.rejects(h.handlers['douyin:send-message'](null,{name:'虚拟朋友',text:'草稿',metadata:{draftId:'old'}}),/未确认/)
  assert.equal(h.get().pendingDrafts.length,2)
})
test('discard only removes its row and preserves independent event/video flows',()=>{
  const h=harness();h.handlers['drafts:discard'](null,'old');assert.deepEqual(h.get().pendingDrafts.map(d=>d.id),['other'])
  for(const patch of [{source:'event_followup'},{videoOpeningId:'video'}]){const next=harness();next.set({pendingDrafts:[{...next.get().pendingDrafts[0],...patch}]});assert.throws(()=>next.handlers['drafts:discard'](null,'old'),/对应/);assert.equal(next.get().pendingDrafts.length,1)}
})
test('manual message without a draft keeps its existing send route',async()=>{
  const h=harness();await h.handlers['douyin:send-message'](null,{name:'虚拟朋友',text:'本人手动'})
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].metadata,undefined);assert.equal(h.get().pendingDrafts.length,2)
})
test('a brief backend pause invalidates a generation even if resume happens before the model returns',()=>{
  const h=harness();let pauses=0
  h.entry.douyin.incomingBuffer={pause:()=>pauses++};h.entry.douyin.startWorker=()=>{}
  const start=source.indexOf("ipcMain.handle('automation:update'"),stop=source.indexOf('// AI 服务 IPC',start)
  vm.runInNewContext(source.slice(start,stop),h.ctx)
  h.handlers['automation:update'](null,{automation:{paused:true}})
  h.handlers['automation:update'](null,{automation:{paused:false}})
  assert.equal(pauses,1)
})
test('turning off burst waiting invalidates its in-flight generation immediately',()=>{
  const h=harness();let pauses=0
  h.entry.douyin.incomingBuffer={pause:()=>pauses++};h.entry.douyin.startWorker=()=>{}
  h.ctx.applySystemSettings=()=>{}
  const start=source.indexOf("ipcMain.handle('automation:update'"),stop=source.indexOf('// AI 服务 IPC',start)
  vm.runInNewContext(source.slice(start,stop),h.ctx)
  h.handlers['automation:update'](null,{settings:{incomingBurstEnabled:false}})
  assert.equal(pauses,1)
})
test('account activation cancels the former account buffer before switching services',()=>{
  const h=harness();let pauses=0
  h.entry.douyin.incomingBuffer={pause:()=>pauses++}
  const next={storage:{get:()=>({settings:{}})}}
  Object.assign(h.ctx,{services:new Map([['A',h.entry],['B',next]]),stopContactService:()=>{},stopDiscoveryService:()=>{},startDiscoveryService:()=>{},startContactService:()=>{},applySystemSettings:()=>{}})
  const start=source.indexOf('function activateAccount('),stop=source.indexOf('\nasync function clearAccount',start)
  vm.runInNewContext(source.slice(start,stop),h.ctx)
  h.ctx.activateAccount('B');assert.equal(pauses,1);assert.equal(h.ctx.activeAccount,'B')
})
