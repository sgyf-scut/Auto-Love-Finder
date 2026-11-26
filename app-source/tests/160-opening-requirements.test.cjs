const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {FriendshipService}=require('../electron/friendship.cjs')
const {AiService}=require('../electron/ai-service.cjs')
const {BatchRunner}=require('../electron/discovery/batch-runner.cjs')
const {CandidateManager}=require('../electron/discovery/candidate-manager.cjs')
const {migrateLegacy}=require('../electron/storage.cjs')
const policy=require('../electron/opening-requirements.cjs')
const url='https://www.douyin.com/user/fixture-opening'
function fixture(settings={}){
 const storage=createMemoryStorage({settings,selfProfile:{version:1,revision:0,stableProfile:[],currentLife:[],privacyPreferences:[],introductionText:'未审核的私密介绍',pending:{sourceText:'未审核的私密介绍'}}})
 const ai=new AiService(storage),friend=new FriendshipService({storage,ai,partition:'fixture',log(){}}),requests=[]
 ai.inquiryCompletion=async messages=>{requests.push(messages);return {text:JSON.stringify({reply:'看你说晚上缺一，你们玩哪个区呀？'}),usage:{total:19}}}
 return {storage,ai,friend,requests}
}
test('default opening follows requirements without approved personal details or a configured real provider',async()=>{
 const f=fixture({openingRequirements:'只问区服，一句话，不要自我介绍'})
 const out=await f.friend.approachPreview({url,name:'测试',commentText:'晚上缺一',videoTitle:'游戏组队'})
 assert.equal(out.text,'看你说晚上缺一，你们玩哪个区呀？');assert.equal(f.requests.length,1)
 const input=JSON.parse(f.requests[0].at(-1).content)
 assert.equal(input.openingRequirements,'只问区服，一句话，不要自我介绍');assert.match(input.publicProfile.summary,/晚上缺一.*游戏组队/)
 assert.doesNotMatch(JSON.stringify(f.requests),/未审核的私密介绍/)
})
test('custom goal instructions supplement the common requirements and are kept out of regular replies',async()=>{
 const f=fixture({openingRequirements:'只打招呼，不提问'})
 const goal={name:'游戏搭子',description:'有组队意愿',instructions:'问区服'}
 await f.friend.approachPreview({url,name:'测试',commentText:'晚上缺一',openingGoal:goal})
 const input=JSON.parse(f.requests[0].at(-1).content)
 assert.deepEqual(input.openingGoal,goal);assert.equal(input.openingRequirements,'只打招呼，不提问')
 assert.match(f.requests[0][0].content,/冲突时以通用要求为准/)
 let dedicated=0;f.ai.draftFirstMessage=async()=>{dedicated++;throw Error('should not run for ordinary reply')}
 await f.ai.draftRelationshipMessageLegacy({candidate:{name:'测试'},opening:false,openingRequirements:'unused'})
 assert.equal(dedicated,0)
})
test('a new first message does not use or mutate a same-named contact history',async()=>{
 const f=fixture({openingRequirements:'简单问候'})
 f.storage.update({contacts:[{id:'old',name:'测试',learning:{messages:[{role:'contact',text:'另一人的旧私密聊天'}],relationshipPlan:{selectedTopic:'old'}}}]})
 const before=f.storage.get().contacts
 await f.friend.approachPreview({url,name:'测试',commentText:'想认识朋友'})
 assert.doesNotMatch(JSON.stringify(f.requests),/另一人的旧私密聊天/);assert.deepEqual(f.storage.get().contacts,before)
})
test('fixed mode returns the exact text without a model, persona or custom-goal additions',async()=>{
 const text=' 你好呀！\n想认识一下😊 '
 const f=fixture({openingMode:'fixed',fixedOpeningText:text,openingRequirements:'写三段'})
 f.friend.douyin.ai={draftRelationshipMessageLegacy:()=>assert.fail('fixed mode cannot call a model')}
 const out=await f.friend.approachPreview({url,name:'测试',openingGoal:{name:'游戏',description:'组队',instructions:'另加区服'}})
 assert.equal(out.text,text);assert.equal(out.aiCalls,0);assert.equal(out.fixed,true)
 const again=await f.friend.opening(url);assert.equal(again.text,text)
})
test('invalid fixed text cannot silently fall back to a model or a different opener',async()=>{
 for(const text of ['', '   ', '好'.repeat(81)]){
  const f=fixture({openingMode:'fixed',fixedOpeningText:text})
  await assert.rejects(f.friend.approachPreview({url,name:'测试'}),/1～80/);assert.equal(f.requests.length,0)
 }
})
test('an explicitly captured opening policy survives edits made after the draft was queued',async()=>{
 const f=fixture({openingMode:'fixed',fixedOpeningText:'原来的一句'})
 const snapshot=policy.openingPolicyOf(f.storage.get())
 f.storage.update({settings:{openingMode:'ai',openingRequirements:'后来要求'}})
 const out=await f.friend.approachPreview({url,name:'测试',openingPolicy:snapshot})
 assert.equal(out.text,'原来的一句');assert.equal(f.requests.length,0)
})
test('fixed drafts do not consume the AI budget and can be generated when that budget is zero',async()=>{
 const f=fixture({openingMode:'fixed',fixedOpeningText:'你好，想认识一下'}),manager=new CandidateManager(f.storage)
 const c=manager.upsert([{platformUserId:'fixture-opening',profileUrl:url,nickname:'测试',libraryIntent:'SEEKING_FRIENDS',source:{type:'comment',topic:'manual_keywords',keyword:'测试',videoId:'7700000000000000001',commentText:'想找朋友'}}],{accountId:'fixture'}).discovery.candidates[0]
 manager.save({...manager.get(),batch:{id:'batch',status:'done',config:{budgets:{maxAiCalls:0}},progress:{drafts:0,aiCalls:0},added:[]}})
 const runner=new BatchRunner({storage:f.storage,manager,openingPolicy:()=>policy.openingPolicyOf(f.storage.get()),draftOpening:(_c,input)=>f.friend.approachPreview(input)})
 runner.scheduleDraft(c,runner.state);await runner.finishDrafts()
 assert.equal(manager.get().candidates[0].review.draftOpening,'你好，想认识一下');assert.equal(runner.state.progress.aiCalls,0);assert.equal(runner.state.progress.drafts,1);assert.equal(f.requests.length,0)
})
test('old and malformed settings normalize without erasing unrelated settings',()=>{
 const state=migrateLegacy({settings:{quietStart:'20:00',openingMode:'bogus',openingRequirements:{bad:true},fixedOpeningText:4}})
 assert.equal(state.settings.openingMode,'ai');assert.equal(state.settings.openingRequirements,'');assert.equal(state.settings.fixedOpeningText,'');assert.equal(state.settings.quietStart,'20:00')
 assert.equal(policy.normalizeOpeningRequirements('甲'.repeat(2200)).length,2000)
})
function handler(storage){
 const text=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),start=text.indexOf("ipcMain.handle('friendship:opening-requirements'"),end=text.indexOf('\n})',start)+3
 let fn;const c=vm.createContext({activeAccount:'a',getActiveServices:()=>({storage}),ipcMain:{handle:(_name,cb)=>{fn=cb}},require:()=>policy})
 vm.runInContext(text.slice(start,end),c);return fn
}
test('saving first-message settings is account scoped, validates fixed text, and never changes chat controls or drafts',async()=>{
 const f=fixture(),save=handler(f.storage),before=f.storage.get()
 assert.equal((await save(null,{accountId:'b',requirements:'wrong'})).ok,false)
 assert.equal((await save(null,{accountId:'a',requirements:'req',mode:'fixed',fixedText:''})).ok,false)
 assert.equal((await save(null,{accountId:'a',requirements:'甲'.repeat(2001)})).ok,false)
 assert.equal((await save(null,{accountId:'a',requirements:'req',mode:'fixed',fixedText:'固定首句'})).ok,true)
 const after=f.storage.get();assert.equal(after.settings.openingMode,'fixed');assert.equal(after.settings.fixedOpeningText,'固定首句')
 assert.deepEqual(after.automation,before.automation);assert.deepEqual(after.pendingDrafts,before.pendingDrafts);assert.deepEqual(after.selfProfile,before.selfProfile)
})
function ui(){
 const nodes=new Map(),notices=[],api={onDouyinEvent(){},accounts:{onChanged(){}},friendship:{saveOpeningRequirements:async p=>({ok:true,...p})}}
 const c=vm.createContext({window:{desktopApp:api},document:{addEventListener(){},querySelector:()=>null,getElementById:id=>nodes.get(id)||null},setInterval(){},setTimeout(){},clearTimeout(){}})
 const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8').replace(/loadAll\(\)\s*$/,'')
 vm.runInContext(source+'\nrender=()=>{};showNotice=x=>notices.push(x);S.accounts.active="a";S.data={settings:{},selfProfile:{},automation:{},discovery:{candidates:[]}};globalThis.subject={S,ACTIONS,openingRequirementsView,discoveryView,patchAutoModePanel};',Object.assign(c,{notices}))
 return {...c.subject,c,nodes,api,notices}
}
test('requirements are visible directly above the personal introduction and escape entered text',()=>{
 const f=ui();f.S.section='discovery';f.S.data.settings.openingRequirements='<script>bad()</script>'
 const html=f.discoveryView();assert.ok(html.indexOf('id="opening-requirements-panel"')<html.indexOf('id="self-introduction"'))
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>bad/)
 f.S.data.settings.openingMode='fixed';f.S.data.settings.fixedOpeningText='你好'
 assert.match(f.openingRequirementsView(),/id="fixed-opening-text"/);assert.match(f.openingRequirementsView(),/不调用模型/)
})
test('a late settings save cannot write another account UI or overwrite text typed while saving',async()=>{
 const f=ui();let resolve;f.api.friendship.saveOpeningRequirements=()=>new Promise(r=>{resolve=r})
 f.nodes.set('opening-requirements',{value:'原要求'});const run=f.ACTIONS['opening-requirements-save']({},null)
 f.nodes.get('opening-requirements').value='新输入';f.S.discovery.openingRequirementsDraft='新输入';resolve({ok:true,requirements:'原要求',mode:'ai',fixedText:''});await run
 assert.equal(f.nodes.get('opening-requirements').value,'新输入');assert.equal(f.S.discovery.openingRequirementsDraft,'新输入')
 const second=f.ACTIONS['opening-requirements-save']({},null);f.S.accounts.active='b';f.S.discovery={};f.S.data={settings:{}}
 resolve({ok:true,requirements:'旧账号',mode:'ai',fixedText:''});await second;assert.equal(f.S.data.settings.openingRequirements,undefined)
})
test('saving fixed mode retains the AI requirements when that text field is not displayed',async()=>{
 const f=ui();f.S.data.settings={openingRequirements:'原来的AI要求',openingMode:'fixed'};f.nodes.set('fixed-opening-text',{value:'原样首句'})
 let request;f.api.friendship.saveOpeningRequirements=async p=>{request=p;return {ok:true,...p}}
 await f.ACTIONS['opening-requirements-save']({},null)
 assert.equal(request.requirements,'原来的AI要求');assert.equal(request.fixedText,'原样首句');assert.equal(request.mode,'fixed')
})
test('mode refresh replaces its own wrapper instead of nesting a duplicate panel ID',()=>{
 const f=ui(),panel={contains:()=>false,scrollTop:23,outerHTML:''}
 Object.defineProperty(panel,'innerHTML',{set(){assert.fail('Would nest another auto-mode-panel')}})
 f.nodes.set('auto-mode-panel',panel)
 assert.equal(f.patchAutoModePanel(),true);assert.equal((panel.outerHTML.match(/id="auto-mode-panel"/g)||[]).length,1);assert.equal(panel.scrollTop,23)
})
