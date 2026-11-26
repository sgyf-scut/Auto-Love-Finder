const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { ContactEngine } = require('../electron/contact-engine.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { BatchRunner, normalizeBatchConfig } = require('../electron/discovery/batch-runner.cjs')
const { VideoSources, challengeLookupSnapshot } = require('../electron/discovery/video-sources.cjs')
const { parseSearchTerms, keywordQueries, rankVideos } = require('../electron/discovery/search-query.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { migrateLegacy } = require('../electron/storage.cjs')

test('common separators and array entries parse identically without damaging C++ C# or English phrases', () => {
  assert.deepEqual(parseSearchTerms('游戏搭子，王者荣耀; 游戏搭子；#搭子、C++|C#/Final Fantasy\n摄影\t同城\\运动'), ['游戏搭子','王者荣耀','搭子','C++','C#','Final Fantasy','摄影','同城','运动'])
  assert.deepEqual(parseSearchTerms(['游戏搭子，王者荣耀','王者荣耀']), ['游戏搭子','王者荣耀'])
  assert.deepEqual(parseSearchTerms([{}, null, 1]), [])
  assert.equal(parseSearchTerms(Array.from({length:20}, (_,i) => 'term'+i)).length, 10)
})
test('new batches combine both fields first, deduplicate, and allow opting out', () => {
  const cfg = normalizeBatchConfig({sources:{keywords:'游戏搭子；王者荣耀',tags:['#王者荣耀']}})
  assert.deepEqual(keywordQueries(cfg.sources), ['游戏搭子 王者荣耀','游戏搭子','王者荣耀'])
  assert.deepEqual(keywordQueries({...cfg.sources,combinedSearch:false}), ['游戏搭子','王者荣耀'])
  assert.deepEqual(keywordQueries({keywords:['old'],tags:['batch']}), ['old'])
})
test('ranking uses actual visible evidence, keeps unknown titles, and is stable for ties', () => {
  const rows = [{videoId:'1',title:'游戏搭子',query:'游戏搭子 王者荣耀',sourceType:'keyword'}, {videoId:'2',title:'王者荣耀 游戏搭子'}, {videoId:'3',title:null}, {videoId:'4',title:'王者荣耀 游戏搭子'}]
  const ranked = rankVideos(rows, {keywords:['游戏搭子'],tags:['王者荣耀'],combinedSearch:true})
  assert.deepEqual(ranked.map(x=>x.videoId), ['2','4','1','3'])
  assert.deepEqual(ranked[2].matchedSearchTerms,['游戏搭子']);assert.equal(ranked.length,rows.length)
  assert.equal(rows[0].matchedSearchTerms,undefined)
  assert.equal(rankVideos(rows, {keywords:['游戏搭子'],tags:['王者荣耀']}), rows)
})
function batchFixture() {
  const storage = createMemoryStorage(), manager = new CandidateManager(storage)
  const runner = new BatchRunner({storage,manager,accountId:'a',libraryStore:{read:()=>({videos:[],comments:[]})}})
  return {storage,manager,runner}
}
test('new batch clears stale favorites progress rather than merging it into the new source', async () => {
  const {manager,runner} = batchFixture()
  manager.save({...manager.get(), batch:{id:'old',status:'done',sourceProgress:{phase:'旧收藏夹44条'},added:[]}})
  runner.run=async()=>runner.state
  const out=await runner.start({sources:{tags:['游戏搭子']}})
  assert.equal(out.sourceProgress,null);assert.equal(out.sourcePlanningPending,false);assert.deepEqual(out.sourceRuns,[])
})
test('batch planning actually runs combined query first and sorts pending videos by multiple matches', async () => {
  const {manager,runner}=batchFixture(), calls=[]
  manager.save({...manager.get(), batch:{id:'x',status:'running',queue:[],sourceRuns:[],progress:{},config:normalizeBatchConfig({sources:{tags:['游戏搭子','王者荣耀']}})}})
  runner.sourcesFactory=()=>({collectByKeyword:async q=>{calls.push(q);return {ok:true,videos:[{videoId:'11111111',title:'只玩王者荣耀'}]}},collectByTag:async q=>{calls.push(q);return {ok:true,videos:[{videoId:'22222222',title:'王者荣耀 #游戏搭子'},{videoId:'11111111',title:'只玩王者荣耀'}]}}})
  await runner.planVideos(runner.state,()=>true)
  assert.deepEqual(calls,['游戏搭子 王者荣耀','游戏搭子','王者荣耀'])
  assert.deepEqual(runner.state.queue.map(x=>x.videoId),['22222222','11111111'])
})
function sourceFixture(lookup, state={ready:true}) {
  const win={webContents:{getURL:()=> 'https://www.douyin.com/',executeJavaScript:async()=>state}}
  const s=new VideoSources({douyin:{},ensureWindow:()=>win});let calls=0,fallback=0
  s.evalInPage=async()=>lookup(++calls)
  s.preparePage=async()=>{}
  s.collectByKeyword=async(q,opts)=>{fallback++;return {ok:true,kind:'OK',videos:[{videoId:'11111111'}],events:[{fallback:'visible_page'}],query:q,pages:1}}
  return {s,counts:()=>({calls,fallback})}
}
test('tag lookup transient failure retries only once, then visible keyword search preserves diagnostics',async()=>{
  const f=sourceFixture(()=>({ok:false,kind:'API_ERROR',code:99,http:200,error:'temporary'}))
  const out=await f.s.collectByTag('游戏搭子')
  assert.equal(out.ok,true);assert.deepEqual(f.counts(),{calls:2,fallback:1});assert.equal(out.sourceType,'hashtag');assert.equal(out.lookupKind,'API_ERROR')
  assert.equal(out.events[0].code,99);assert.equal(out.events[1].attempt,2);assert.equal(out.events[2].fallback,'tag_keyword_search')
})
test('transient tag failure can recover on retry without falling back',async()=>{
  const f=sourceFixture(n=>n===1?{ok:false,kind:'NETWORK_ERROR'}:{ok:true,topics:[{chId:'123',name:'游戏搭子'}]})
  f.s.requestVideos=async()=>({ok:true,items:[{videoId:'11111111'}],hasMore:0})
  const out=await f.s.collectByTag('游戏搭子');assert.equal(out.ok,true);assert.deepEqual(f.counts(),{calls:2,fallback:0})
})
test('unavailable tag falls back to normal search without repeating an empty lookup',async()=>{
  const f=sourceFixture(()=>({ok:true,topics:[]})),out=await f.s.collectByTag('游戏搭子')
  assert.equal(out.ok,true);assert.equal(out.lookupKind,'NO_TOPIC');assert.deepEqual(f.counts(),{calls:1,fallback:1})
})
test('login, rate limits and visible challenges never retry or enter keyword fallback',async()=>{
  for(const kind of ['LOGIN_REQUIRED','ACCESS_RESTRICTED','READ_CANCELLED']){
    const f=sourceFixture(()=>({ok:false,kind})),out=await f.s.collectByTag('x')
    assert.equal(out.kind,kind);assert.deepEqual(f.counts(),{calls:1,fallback:0})
  }
  const f=sourceFixture(()=>assert.fail('no lookup while gated'),{code:'ACCESS_RESTRICTED'})
  assert.equal((await f.s.collectByTag('x')).kind,'ACCESS_RESTRICTED');assert.deepEqual(f.counts(),{calls:0,fallback:0})
})
test('tag HTTP and platform errors remain distinct instead of all becoming API_ERROR',async()=>{
  for (const [http,body,kind] of [[401,'','LOGIN_REQUIRED'],[429,'','ACCESS_RESTRICTED'],[403,'','ACCESS_RESTRICTED'],[200,'{"status_code":2483}','LOGIN_REQUIRED'],[200,'{"status_code":91,"status_msg":"temporary"}','API_ERROR']]) {
    const c={AbortController,setTimeout,clearTimeout,fetch:async()=>({status:http,text:async()=>body})}
    const out=await vm.runInNewContext('('+challengeLookupSnapshot.toString()+')({keyword:"x"})',c)
    assert.equal(out.kind,kind);assert.equal(out.http,http);if(kind==='API_ERROR'){assert.equal(out.code,91);assert.equal(out.error,'temporary')}
  }
})
test('contact statistics read one snapshot regardless of candidate count and do not mutate storage',()=>{
  const storage=createMemoryStorage(), manager=new CandidateManager(storage)
  manager.upsert(Array.from({length:80},(_,i)=>({platformUserId:'fixture'+i,profileUrl:'https://www.douyin.com/user/fixture'+i,nickname:'测试'+i,source:{type:'user_search',keyword:'摄影'}})),{accountId:'a'})
  const engine=new ContactEngine({storage,douyin:{},accountId:'a'}), before=storage.get();let reads=0
  const get=storage.get;storage.get=()=>{reads++;return get()}
  const out=engine.state();assert.equal(reads,1);assert.equal(out.metrics.discovered,80);assert.deepEqual(get(),before)
})
test('contact hard gates read fresh state on each action rather than reusing a previous UI snapshot',()=>{
  const {storage,manager}=batchFixture()
  const candidate=manager.upsert([{platformUserId:'fixture',profileUrl:'https://www.douyin.com/user/fixture',nickname:'测试',source:{type:'user_search',keyword:'摄影'}}],{accountId:'a'}).discovery.candidates[0]
  const engine=new ContactEngine({storage,douyin:{},accountId:'a'});let reads=0
  const get=storage.get;storage.get=()=>{reads++;return get()}
  engine.state();const n=reads;storage.update({automation:{blacklist:['测试']}});const gate=engine.hard(candidate)
  assert.ok(reads>n);assert.equal(gate.ok,false);assert.match(JSON.stringify(gate),/黑名单|blacklist/)
})
test('refresh writes all derived brains once and retains sent ledgers and identities',()=>{
  const {storage,manager}=batchFixture()
  manager.upsert(Array.from({length:5},(_,i)=>({platformUserId:'fixture'+i,profileUrl:'https://www.douyin.com/user/fixture'+i,nickname:'测试'+i,source:{type:'user_search',keyword:'摄影'}})),{accountId:'a'})
  const engine=new ContactEngine({storage,douyin:{},accountId:'a'}),before=manager.get().candidates;let writes=0
  const update=storage.update;storage.update=p=>{writes++;return update(p)}
  const result=engine.refresh();assert.equal(writes,1);assert.equal(result.discovery.candidates.length,5)
  for(let i=0;i<5;i++){assert.deepEqual(result.discovery.candidates[i].contact,before[i].contact);assert.equal(result.discovery.candidates[i].profileUrl,before[i].profileUrl)}
})
function aiFixture(notes='') {
  const storage=createMemoryStorage({providers:[{name:'fake',model:'fake'}],settings:{proactiveChat:{topicNotes:notes}}}),ai=new AiService(storage),calls=[]
  ai.profileChatCompletion=async messages=>{calls.push(messages);return {text:'买咖啡时顺口叫了声老师，把我和店员都逗笑了',model:'fake'}}
  ai.assertProfileReply=()=>{}
  return {storage,ai,calls}
}
test('companion material reaches the real model boundary as data for ordinary and friendship contacts',async()=>{
  for(const profile of [{},{chatMode:'friendship'}]){
    const f=aiFixture('今天买咖啡叫店员老师');f.ai.draftRelationshipMessage=()=>assert.fail('Guided companion must receive material')
    const out=await f.ai.draftCompanionMessage({contact:{name:'测试',profile}})
    assert.equal(out.ok,true);assert.equal(JSON.parse(f.calls[0][1].content).ownerTopicMaterial,'今天买咖啡叫店员老师')
    assert.match(f.calls[0][0].content,/不增添人物/);assert.doesNotMatch(f.calls[0][0].content,/今天买咖啡叫店员老师/)
  }
})
test('empty companion material preserves autonomous ordinary prompt and original friendship route',async()=>{
  const f=aiFixture();await f.ai.draftCompanionMessage({contact:{name:'测试'}})
  assert.equal(f.calls[0][1].content,'现在请生成一条主动发给对方的自然消息。')
  let old=0;f.ai.draftRelationshipMessage=async()=>{old++;return {ok:true,text:'旧流程'}}
  assert.equal((await f.ai.draftCompanionMessage({contact:{name:'测试',profile:{chatMode:'friendship'}}})).text,'旧流程');assert.equal(old,1)
})
test('companion retry retains material rather than returning to unrestricted autonomous topics',async()=>{
  const f=aiFixture('买咖啡叫错称呼');let n=0
  f.ai.profileChatCompletion=async messages=>{f.calls.push(messages);return {text:++n===1?'😊':'买咖啡时顺口叫了声老师，把自己逗笑了'}}
  await f.ai.draftCompanionMessage({contact:{name:'测试'}})
  assert.equal(f.calls.length,2);assert.equal(JSON.parse(f.calls[1][1].content).ownerTopicMaterial,'买咖啡叫错称呼')
})
test('companion material is optional, bounded and isolated in the active account storage',()=>{
  assert.equal(migrateLegacy({}).settings.proactiveChat.topicNotes,'')
  assert.equal(migrateLegacy({settings:{proactiveChat:{enabled:false,topicNotes:'甲'.repeat(2100)}}}).settings.proactiveChat.topicNotes.length,2000)
  assert.equal(migrateLegacy({settings:{proactiveChat:{topicNotes:{bad:true}}}}).settings.proactiveChat.topicNotes,'')
  const a=aiFixture('只在A'),b=aiFixture();assert.equal(b.storage.get().settings.proactiveChat.topicNotes,'');assert.equal(a.storage.get().settings.proactiveChat.enabled,undefined)
})
function companionScheduler() {
  const settings={proactiveChat:{enabled:true,windowStart:'00:00',windowEnd:'00:00',sendToDraft:true,openingType:'video',topicNotes:'今天咖啡店的笑话'}}
  const storage=createMemoryStorage({contacts:[{name:'模拟朋友',profile:{chatMode:'oldfriend'}}],settings})
  let calls=0
  const douyin=new DouyinService({storage,ai:{draftCompanionMessage:async()=>{calls++;return {ok:true,text:'咖啡店今天发生个好笑的事'}}}})
  douyin.videoOpenings={create:()=>assert.fail('Material should use a text opener')}
  douyin.sendMessage=()=>assert.fail('Draft mode must not send')
  return {storage,douyin,calls:()=>calls}
}
test('scheduled companion material uses text, keeps draft mode, blacklist and daily interval limits',async()=>{
  const f=companionScheduler()
  await f.douyin.processProactiveChats(new Date(),new Set(['模拟朋友']),new Set());assert.equal(f.calls(),0)
  await f.douyin.processProactiveChats(new Date(),new Set(),new Set(['模拟朋友']));assert.equal(f.calls(),0)
  await f.douyin.processProactiveChats(new Date(),new Set(),new Set());assert.equal(f.calls(),1);assert.equal(f.storage.get().pendingDrafts.length,1)
  await f.douyin.processProactiveChats(new Date(),new Set(),new Set());assert.equal(f.calls(),1)
})
test('editing companion material during generation invalidates the old draft before queueing or sending',async()=>{
  const f=companionScheduler()
  f.douyin.ai.draftCompanionMessage=async()=>{f.storage.update({settings:{proactiveChat:{topicNotes:'新的话题'}}});return {ok:true,text:'旧话题'}}
  await f.douyin.processProactiveChats(new Date(),new Set(),new Set());assert.equal(f.storage.get().pendingDrafts.length,0);assert.equal(f.storage.get().proactiveState,undefined)
})
function uiFixture() {
 const nodes=new Map(),api={onDouyinEvent(){},accounts:{onChanged(){}}}
 const c=vm.createContext({window:{desktopApp:api},document:{addEventListener(){},getElementById:id=>nodes.get(id)||null,querySelector:()=>null},setInterval(){},setTimeout(){},clearTimeout(){}})
 const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8').replace(/loadAll\(\)\s*$/,'')
 vm.runInContext(source+'\nrender=()=>{};S.data={settings:{},contacts:[],automation:{},discovery:{}};S.accounts.active="a";globalThis.subject={S,loadAll,readBatchConfig,batchPanelView,tasksView,saveState};',c)
 return {...c.subject,nodes,api,c}
}
test('UI accepts documented separators and shows multi-term search and companion fields',()=>{
  const f=uiFixture();f.nodes.set('batch-keywords',{value:'游戏搭子；王者荣耀|C++'});f.nodes.set('batch-tags',{value:'#搭子/#王者荣耀'})
  const out=f.readBatchConfig();assert.deepEqual(Array.from(out.sources.keywords),['游戏搭子','王者荣耀','C++']);assert.deepEqual(Array.from(out.sources.tags),['搭子','王者荣耀'])
  assert.equal(out.sources.combinedSearch,true);assert.match(f.batchPanelView(),/优先组合多个词搜索/)
  f.S.data.settings.proactiveChat={topicNotes:'<script>bad</script>'}
  assert.match(f.tasksView(),/伴聊话题素材/);assert.doesNotMatch(f.tasksView(),/<script>bad/)
})
test('first usable view does not wait for optional contact statistics and stale status cannot cross accounts',async()=>{
  const f=uiFixture();let rendered=0,resolve
  vm.runInContext('render=()=>{globalThis.rendered()} ',Object.assign(f.c,{rendered:()=>rendered++}))
  f.api.getInfo=async()=>({});f.api.accounts.list=async()=>({active:'a'});f.api.automation={getState:async()=>({settings:{},contacts:[]})}
  f.api.douyin={getStatus:()=>new Promise(r=>resolve=r)};f.api.contact={getState:()=>assert.fail('Stale optional request must not start')}
  const run=f.loadAll();await new Promise(setImmediate);assert.equal(rendered,1)
  f.S.accounts.active='b';f.S.accountEpoch=(f.S.accountEpoch||0)+1;resolve({connected:true});await run
  assert.equal(f.S.status.connected,false)
})
test('a late settings save cannot replace the new account UI after a switch',async()=>{
  const f=uiFixture();let resolve
  f.api.automation={update:()=>new Promise(r=>{resolve=r})}
  const run=f.saveState({settings:{proactiveChat:{topicNotes:'旧账号'}}});f.S.accounts.active='b';f.S.data={marker:'new-account'}
  resolve({state:{marker:'old-account'}});await run;assert.equal(f.S.data.marker,'new-account')
})
