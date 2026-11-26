const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path')
const {createMemoryStorage} = require('./setup.cjs')
const {CandidateManager} = require('../electron/discovery/candidate-manager.cjs')
const {executeBatchContact} = require('../electron/discovery/batch-contact-service.cjs')
const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')
const pending = () => { let resolve; const promise = new Promise(r => {resolve = r}); return {resolve, promise} }
function ui() {
 const nodes = new Map(), timers = [], notices = [], calls = []
 const api = {onDouyinEvent(){}, accounts:{onChanged(){}}, discovery:{batchStatus:async()=>({ok:true,batch:{status:'stopped'},cards:[]})}}
 const document = {activeElement:null, addEventListener(){}, querySelectorAll:()=>[], querySelector:()=>null, getElementById:id=>nodes.get(id)||null}
 const c = vm.createContext({window:{desktopApp:api}, document, setInterval(){},clearInterval(){},setTimeout:fn=>{timers.push(fn)},clearTimeout(){},console})
 vm.runInContext(source+`
 S.section='discovery'; S.accounts.active='a'; S.data={contacts:[],automation:{aiDisabledContacts:[]},discovery:{candidates:[]}};
 render=()=>{}; refreshDiscovery=()=>{}; showNotice=(message)=>testNotices.push(message); batchPoll=()=>{};
 batchPanelView=()=>batchState().data?.status+':'+batchState().busy;
 batchCardsView=()=>'';
 globalThis.subject={S,ACTIONS,BATCH_ACTIONS,batchState,loadBatch,patchBatch,contactListItems,selectedConversation,conversationsWithPendingWork,beginAccountUiTransition,refreshDynamic};`,Object.assign(c,{testNotices:notices}))
 return {...c.subject,api,document,nodes,c,timers,notices,calls}
}
function panel(f, focusedTag='BUTTON') {
 const field = {id:'query',type:'text',value:'手填的关键词',tagName:'INPUT',selectionStart:2,selectionEnd:3,focus(){f.document.activeElement=this},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b}}
 f.nodes.set('query',field)
 f.document.querySelectorAll=selector=>selector.includes('#batch-panel')?[field]:[]
 const p={dataset:{},contains:node=>node?.inside===true||node===field,outerHTML:''}
 f.nodes.set('batch-panel',p);f.document.activeElement=focusedTag==='INPUT'?field:{tagName:focusedTag,inside:true}
 return {p,field}
}
test('stop paints the final state immediately while the clicked button keeps focus and preserves form values',async()=>{
 const f=ui(),{p,field}=panel(f);f.batchState().data={status:'running'}
 const wait=pending();f.api.discovery.batchStop=()=>wait.promise
 const stop=f.BATCH_ACTIONS['batch-stop']();assert.equal(p.outerHTML,'running:true')
 wait.resolve({ok:true,batch:{status:'stopped'}});await stop
 assert.equal(p.outerHTML,'stopped:false');assert.equal(field.value,'手填的关键词')
})
test('an in-flight pre-stop status response cannot restore running state',async()=>{
 const f=ui();panel(f);const wait=pending();f.api.discovery.batchStatus=()=>wait.promise
 const request=f.loadBatch();f.api.discovery.batchStop=async()=>({ok:true,batch:{status:'stopped'}})
 await f.BATCH_ACTIONS['batch-stop']();wait.resolve({ok:true,batch:{status:'running'},cards:[]});await request
 assert.equal(f.batchState().data.status,'stopped')
})
test('pause and resume refresh immediately without resetting an edited form or input selection',async()=>{
 const f=ui(),{p,field}=panel(f,'INPUT');f.batchState().data={status:'running'}
 for(const [action,method,status] of [['batch-pause','batchPause','paused'],['batch-resume','batchResume','running']]){
  f.api.discovery[method]=async()=>({ok:true,batch:{status}});await f.BATCH_ACTIONS[action]()
  assert.equal(p.outerHTML,status+':false');assert.equal(field.value,'手填的关键词');assert.equal(field.selectionStart,2);assert.equal(f.document.activeElement,field)
 }
})
test('an account switch fences late control results and resets the history view',async()=>{
 const f=ui();panel(f);f.S.showCachedConversations=true;const wait=pending();f.api.discovery.batchStop=()=>wait.promise
 const stop=f.BATCH_ACTIONS['batch-stop']();f.beginAccountUiTransition('b');wait.resolve({ok:true,batch:{status:'stopped',id:'old'}});await stop
 assert.equal(f.S.showCachedConversations,false);assert.notEqual(f.S.discovery.batch?.data?.id,'old')
})
test('cached contacts and their pending drafts stay out of the current view, but are recoverable without deleting anything',()=>{
 const f=ui(),current={id:'current',name:'当前会话'},cached={id:'old',name:'历史会话',conversationListCurrent:false}
 f.S.data.contacts=[current,cached];f.S.data.pendingDrafts=[{contactId:'old',name:'历史会话',text:'旧草稿'}];f.S.selectedContactId='old'
 assert.equal(f.selectedConversation(),undefined);assert.ok(!f.contactListItems().includes('历史会话'));assert.equal(f.conversationsWithPendingWork().has(cached),false)
 f.S.showCachedConversations=true;assert.equal(f.selectedConversation(),cached);assert.ok(f.contactListItems().includes('历史会话'));assert.equal(f.conversationsWithPendingWork().has(cached),true)
 assert.equal(f.S.data.contacts.length,2);assert.equal(f.S.data.pendingDrafts.length,1)
})
test('a newly cached selection clears the old right-hand detail instead of leaving it on screen',()=>{
 const f=ui();f.S.section='chat';f.S.data.contacts=[{id:'cached',name:'旧会话',conversationListCurrent:false}];f.S.selectedContactId='cached';f.S.selected='旧会话'
 vm.runInContext('applyTheme=()=>{};statusPills=()=>"";globalThis.renders=0;render=()=>{globalThis.renders++}',f.c)
 f.refreshDynamic();assert.equal(f.S.selectedContactId,'');assert.equal(f.S.selected,'');assert.equal(f.c.renders,1)
})
function manager() {
 const storage=createMemoryStorage(), m=new CandidateManager(storage)
 const input={platformUserId:'fixture',nickname:'测试用户',profileUrl:'https://www.douyin.com/user/fixture',libraryIntent:'SEEKING_FRIENDS',status:'DISCOVERED',source:{type:'comment',topic:'manual_keywords',keyword:'测试',videoId:'7700000000000000001',commentText:'也想找朋友'}}
 const id=m.upsert([input],{accountId:'a'}).discovery.candidates[0].id
 return {m,id,input}
}
test('all seven human intent classes persist with correct grades, evidence and no manufactured invitation',()=>{
 const {m,id}=manager()
 for(const [intent,grade] of Object.entries({EXPLICIT_INVITATION:'A',SEEKING_FRIENDS:'B',CONTEXTUAL_INTEREST:'C',ORDINARY:'D',DO_NOT_CONTACT:'D',ADVERTISEMENT:'D',UNKNOWN:'D'})){
  const c=m.setIntent(id,intent).discovery.candidates[0];assert.equal(c.libraryIntent,intent);assert.equal(c.discoveryGrade,grade);assert.equal(c.consentToDm,false);assert.equal(c.sources[0].commentText,'也想找朋友');assert.equal(c.review.intentConfirmation.source,'manual')
 }
 assert.throws(()=>m.setIntent(id,'BOGUS'),/无效/)
})
test('later collection cannot overwrite a human downgrade, and reclassification preserves rejection and sent receipts',()=>{
 const {m,id,input}=manager();m.setIntent(id,'ORDINARY');m.upsert([{...input,libraryIntent:'EXPLICIT_INVITATION',consentToDm:true}],{accountId:'a'})
 assert.equal(m.get().candidates[0].libraryIntent,'ORDINARY')
 m.patch(id,{review:{realContact:{messageStatus:'sent',text:'已发送'}},action:{firstMessageStatus:'sent'}})
 m.setIntent(id,'CONTEXTUAL_INTEREST');assert.equal(m.get().candidates[0].review.realContact.text,'已发送');assert.equal(m.get().candidates[0].action.firstMessageStatus,'sent')
 m.patch(id,{status:'REJECTED'});m.setIntent(id,'EXPLICIT_INVITATION');const c=m.get().candidates[0];assert.equal(c.status,'REJECTED');assert.equal(c.discoveryGrade,'D');assert.equal(c.action.followStatus,'blocked')
})
test('global-candidate contact reuses the receipt boundary and refuses a second first message',async()=>{
 const {m,id}=manager();let calls=0,budget={day:new Date().toISOString().slice(0,10),realFollows:0,realMessages:0}
 const store={autoContactState:()=>({budget}),setAutoContact:patch=>{budget=patch.budget}},friendship={approach:async()=>{calls++;return {ok:true,followed:true,receipt:{status:'sent'}}}}
 const opts={manager:m,store,candidate:m.get().candidates[0],friendship,text:'你好',manual:true}
 const first=await executeBatchContact(opts);assert.equal(first.messageStatus,'sent');assert.equal(calls,1)
 const second=await executeBatchContact(opts);assert.equal(second.code,'ALREADY_SENT');assert.equal(calls,1)
})
test('the global-candidate dialog cancellation sends nothing and keeps automation switches unchanged',async()=>{
 const f=ui();let calls=0
 f.S.data.discovery.candidates=[{id:'one',nickname:'测试',status:'DISCOVERED',review:{draftOpening:'你好'}}];f.S.data.automation={autoReply:false,draftOnly:true}
 f.api.discovery.batchContact=async()=>{calls++;return {ok:true}};vm.runInContext('askApproach=async()=>null',f.c)
 await f.ACTIONS['workspace-approach']({id:'one'})
 assert.equal(calls,0);assert.equal(f.S.data.automation.autoReply,false);assert.equal(f.S.data.automation.draftOnly,true)
})
test('switching accounts while editing the first message cancels the submission',async()=>{
 const f=ui(),wait=pending();f.S.data.discovery.candidates=[{id:'one',nickname:'测试',status:'DISCOVERED',review:{draftOpening:'你好'}}]
 f.c.dialog=wait.promise;vm.runInContext('askApproach=()=>dialog',f.c);let calls=0;f.api.discovery.batchContact=async()=>{calls++}
 const run=f.ACTIONS['workspace-approach']({id:'one'});await new Promise(setImmediate);f.S.accounts.active='b';wait.resolve('发这句');await run;assert.equal(calls,0)
})
test('an uncertain global-candidate receipt updates the visible record even though the operation failed',async()=>{
 const f=ui();f.S.data.discovery.candidates=[{id:'one',nickname:'测试',status:'DISCOVERED',review:{draftOpening:'你好'}}]
 vm.runInContext('askApproach=async()=>"用户确认的首句"',f.c)
 let payload;f.api.discovery.batchContact=async p=>{payload=p;return {ok:false,error:'发送待核实',candidate:{id:'one',review:{realContact:{needsReview:true,messageStatus:'unknown'}}}}}
 await f.ACTIONS['workspace-approach']({id:'one'})
 assert.equal(payload.accountId,'a');assert.equal(payload.origin,'workspace');assert.equal(payload.confirmed,true)
 assert.equal(f.S.data.discovery.candidates[0].review.realContact.needsReview,true);assert.match(f.notices.at(-1),/待核实/)
})
function handler(channel, {m,friendship={}}) {
 const text=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),begin=text.indexOf("  ipcMain.handle('"+channel+"'")
 assert.ok(begin>=0);const end=text.indexOf('\n  })',begin)+6
 let callback
 const services={storage:m.storage,friendship},c=vm.createContext({activeAccount:'a',getActiveServices:()=>services,batchOpeningInput:require('../electron/discovery/batch-runner.cjs').batchOpeningInput,
  ipcMain:{handle:(_name,fn)=>{callback=fn}},libraryStore:()=>({autoContactState:()=>({config:{autoMinIntent:'any'}})}),require:id=>id==='./discovery/candidate-manager.cjs'?{CandidateManager}:require(path.join(__dirname,'../electron',id))})
 vm.runInContext(text.slice(begin,end),c)
 return {callback,c}
}
test('first-message draft rejects another account and discards a model response arriving after a switch',async()=>{
 const {m,id}=manager(),wait=pending();let calls=0
 const h=handler('discovery:batch-draft',{m,friendship:{approachPreview:()=>{calls++;return wait.promise}}})
 const wrong=await h.callback(null,{id,accountId:'b'});assert.equal(wrong.ok,false);assert.equal(calls,0)
 const run=h.callback(null,{id,accountId:'a'});assert.equal(calls,1);h.c.activeAccount='b';wait.resolve({text:'late draft'});const result=await run
 assert.equal(result.ok,false);assert.equal(m.get().candidates[0].review.draftOpening,undefined)
})
test('global-candidate first contact rejects stale account, missing confirmation and an excluded intent before external action',async()=>{
 const {m,id}=manager();let calls=0
 const h=handler('discovery:batch-contact',{m,friendship:{approach:()=>{calls++;assert.fail('No real follow/send')}}})
 assert.equal((await h.callback(null,{id,accountId:'b',confirmed:true})).ok,false)
 assert.equal((await h.callback(null,{id,accountId:'a'})).code,'CONFIRM_REQUIRED')
 m.setIntent(id,'DO_NOT_CONTACT')
 assert.equal((await h.callback(null,{id,accountId:'a',confirmed:true,text:'你好',origin:'workspace'})).ok,false)
 assert.equal(calls,0)
})
