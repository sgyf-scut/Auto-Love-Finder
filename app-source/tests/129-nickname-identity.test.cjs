const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {createMemoryStorage}=require('./setup.cjs')
const {browserNicknameTools}=require('../electron/nickname-identity.cjs')
const {FriendshipService,profileSnapshot,strangerChatSnapshot,activeChatIdentity,contactActionsSnapshot}=require('../electron/friendship.cjs')
const {extractConversationName,conversationIdentityScript}=require('../electron/automation.cjs')
const {CandidateManager}=require('../electron/discovery/candidate-manager.cjs')
const contact=require('../electron/discovery/batch-contact.cjs')
const contactService=require('../electron/discovery/batch-contact-service.cjs')
const url='https://www.douyin.com/user/identity-fixture',name='🌈余忆Ly'
const text=value=>({nodeType:3,nodeValue:value,textContent:value})
function rich(value=name,{missingAlt=false}={}) {
 const chars=Array.from(value),emoji=/\p{Extended_Pictographic}/u.test(chars[0]||'')?chars.shift():''
 return {nodeType:1,tagName:'SPAN',innerText:chars.join(''),textContent:chars.join(''),children:[],
   childNodes:emoji?[{nodeType:1,tagName:'IMG',alt:missingAlt?'':emoji,getAttribute:k=>k==='alt'?(missingAlt?'':emoji):null},text(chars.join(''))]:[text(value)],
   getBoundingClientRect:()=>({left:300,top:20,width:120,height:30}),getAttribute:k=>k==='class'?'RightPanelHeadertitle':null}
}
function fixture({profileName=name,titleName=profileName,peer='identity-fixture',proofId='',missingAlt=false}={}) {
 const nick=rich(profileName,{missingAlt}),title=rich(titleName,{missingAlt})
 title.__reactPropsFixture={curConversation:peer?{toParticipantSecUserId:peer}:{}}
 const button=label=>({innerText:label,disabled:false,getAttribute:()=>null,contains:()=>false,scrollIntoView(){},getBoundingClientRect:()=>({left:10,top:10,width:50,height:20})})
 const controls=[button('已关注'),button('私信')],editor={tagName:'DIV',isContentEditable:true,innerText:'',focus(){},getAttribute:()=>null,getBoundingClientRect:()=>({width:100,height:30})}
 const header={nodeType:1,getBoundingClientRect:()=>({width:200,height:80}),querySelector:()=>nick,parentElement:{parentElement:{querySelectorAll:()=>controls}}}
 if(proofId)header.__reactPropsFixture={userInfo:{nickname:profileName,sec_uid:proofId}}
 const document={title:'',body:{innerText:''},defaultView:{},querySelector:selector=>selector.includes('conversationConversationListwrapper')?null:selector.includes('user-info')?header:editor,
  querySelectorAll(selector){
   if(selector.includes('captcha')||selector.includes('verify'))return[]
   if(/StackLayoutStackChatHeadertitle|RightPanelHeadertitle|chat-header-title/.test(selector))return[title]
   if(selector.includes('contenteditable'))return[editor]
   if(selector.includes('user-info-follow-btn'))return[controls[0]]
   return[]
  }}
 const context=vm.createContext({document,location:new URL(url),URL,getComputedStyle:()=>({display:'block',visibility:'visible'}),MouseEvent:class{}})
 const run=(fn,args)=>vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context)
 return {context,run,header,nick,title,editor}
}

test('emoji rendered as an image is preserved instead of disappearing from innerText',()=>{
 const n=rich();assert.equal(n.innerText,'余忆Ly');assert.equal(browserNicknameTools().read(n).text,name)
})
test('visually rendered aria-hidden emoji images still belong to the nickname',()=>{
 const n=rich();n.childNodes[0].getAttribute=k=>k==='alt'?'🌈':k==='aria-hidden'?'true':null
 assert.equal(browserNicknameTools().read(n).text,name)
})
test('format characters normalize consistently without deleting meaningful symbols',()=>{
 const tools=browserNicknameTools();assert.equal(tools.same('🌈余\u200B忆Ly\uFE0F','🌈余忆Ly'),true)
 for(const a of ['余忆Ly','☀余忆Ly','🌈余忆LY','🌈余忆Ly8'])assert.equal(tools.same(a,name),false)
 assert.equal(tools.same('Ａlice','Alice'),false)
})
test('NFC text normalization supports equivalent accented Unicode',()=>{
 assert.equal(browserNicknameTools().same('Cafe\u0301','Café'),true)
})
test('nested nickname markup and plain text emoji produce the same full name',()=>{
 const n=rich();n.childNodes=[{nodeType:1,tagName:'SPAN',childNodes:[text('🌈')]} ,text('余忆Ly')]
 assert.equal(browserNicknameTools().read(n).text,name)
})
test('unlabelled nickname images stay incomplete instead of guessing the emoji',()=>{
 const r=browserNicknameTools().read(rich(name,{missingAlt:true}));assert.equal(r.complete,false);assert.equal(r.text,'余忆Ly')
})
test('multiple image emoji, flags, joined emoji and punctuation remain part of the full name',()=>{
 const value='👩‍👩‍👧‍👦🇨🇳小兰酱(๑• . •๑)✨'
 const n={nodeType:1,tagName:'SPAN',childNodes:[{tagName:'IMG',alt:'👩‍👩‍👧‍👦'},{tagName:'IMG',alt:'🇨🇳'},text('小兰酱(๑• . •๑)✨')]}
 assert.equal(browserNicknameTools().read(n).text,value)
 assert.equal(browserNicknameTools().same(browserNicknameTools().read(n).text,value),true)
})
for(const [label,fn,args,check] of [
 ['profile',profileSnapshot,[url,false,name],r=>r.ready===true&&!r.wrongPage],
 ['DM',strangerChatSnapshot,[url,name],r=>r.ready===true&&r.platformUserId==='identity-fixture'],
 ['contact probe',contactActionsSnapshot,[url,name],r=>r.identityVerified===true],
 ['active chat',activeChatIdentity,[name],r=>r.verified===true&&r.platformUserId==='identity-fixture'],
])test(`${label} snapshot retains image emoji when executed without module globals`,()=>{
 assert.equal(check(fixture().run(fn,args)),true)
})
test('a missing emoji without corroborated ID evidence cannot authorize the profile',()=>{
 const r=fixture({profileName:'余忆Ly'}).run(profileSnapshot,[url,false,name]);assert.equal(r.nameMismatch,true)
})
test('same nickname on a different profile URL remains blocked',()=>{
 const f=fixture();f.context.location=new URL(url+'-other')
 assert.equal(f.run(profileSnapshot,[url,false,name]).wrongPage,true)
 assert.equal(f.run(strangerChatSnapshot,[url,name]).wrongPage,true)
})
test('same full nickname with another active conversation ID remains blocked',()=>{
 const r=fixture({peer:'other-user'}).run(strangerChatSnapshot,[url,name]);assert.equal(r.wrongRecipient,true)
})
test('missing peer ID never becomes valid from nickname matching alone',()=>{
 assert.equal(fixture({peer:''}).run(strangerChatSnapshot,[url,name]).ready,false)
 assert.equal(fixture({peer:''}).run(activeChatIdentity,[name]).verified,false)
})
test('confirmed profile ID allows a renamed display name without fuzzy nickname matching',()=>{
 const f=fixture({profileName:'新昵称',titleName:'新昵称',proofId:'identity-fixture'})
 assert.equal(f.run(profileSnapshot,[url,false,'旧昵称']).ready,true)
 assert.equal(f.run(strangerChatSnapshot,[url,'旧昵称']).ready,true)
})
test('conflicting profile proof blocks even a matching full nickname',()=>{
 assert.equal(fixture({proofId:'other-user'}).run(profileSnapshot,[url,false,name]).wrongRecipient,true)
})
test('a renamed display without stable header proof is not silently trusted',()=>{
 assert.equal(fixture({profileName:'新昵称'}).run(profileSnapshot,[url,false,'旧昵称']).nameMismatch,true)
})
test('conversation list extraction uses the same rich nickname reader',()=>{
 assert.equal(extractConversationName({querySelector:()=>rich()}),name)
})
test('conversation target script preserves full title and still requires the expected account ID',()=>{
 const f=fixture();const run=id=>vm.runInContext(conversationIdentityScript(name,id),f.context)
 assert.equal(run('identity-fixture').isTargetMatch,true)
 assert.equal(run('other-user').isTargetMatch,false)
})

function greetingHarness(options={}) {
 const f=fixture(options),storage=createMemoryStorage({contacts:[],friendship:{followed:[]}}),calls={inserted:0,sent:0,quota:0}
 const win={show(){},isDestroyed:()=>false,webContents:{focus(){},sendInputEvent(){},async insertText(value){calls.inserted++;f.editor.innerText=value},executeJavaScript:async script=>vm.runInContext(script,f.context)}}
 const douyin={storage,lastSent:new Map(),lastSeen:new Map(),lastReplyTime:new Map(),assertCanSend(){},emitEvent(){},log(){},
  recordSuccessfulSend(){calls.quota++},recordConversationMessage(){},
  async sendCurrentInput(_win,metadata){await metadata.assertTarget();assert.equal(await win.webContents.executeJavaScript(metadata.targetCheckScript),true);calls.sent++}}
 const service=new FriendshipService(douyin);service.ensureWindow=()=>win;service.navigate=async()=>{};service.settle=async()=>{};service.realClick=async()=>{}
 service.wait=async(_win,fn,args,accept=r=>r?.ready)=>{const r=f.run(fn,args);if(r.wrongPage||r.wrongRecipient||!accept(r))throw Error('fixture identity failed');return r}
 return {f,service,storage,calls}
}
test('complete first-greeting generation path with image emoji records exactly one synthetic send',async()=>{
 const h=greetingHarness();const r=await h.service.greetingCandidate({url,name},'fixture message')
 assert.equal(r.ok,true);assert.equal(h.calls.sent,1);assert.equal(h.calls.quota,1)
 assert.equal(h.storage.get().contacts[0].name,name);assert.equal(h.storage.get().contacts[0].profile.platformUserId,'identity-fixture')
})
test('wrong synthetic recipient is never typed into or sent to, despite identical emoji nickname',async()=>{
 const h=greetingHarness({peer:'other-user'})
 await assert.rejects(h.service.greetingCandidate({url,name},'fixture message'))
 assert.equal(h.calls.inserted,0);assert.equal(h.calls.sent,0);assert.equal(h.calls.quota,0)
})
test('a partially unread nickname fails before following and carries a known identity error',async()=>{
 const h=greetingHarness({missingAlt:true});let clicks=0
 h.service.wait=(win,fn,args,accept)=>FriendshipService.prototype.wait.call(h.service,win,fn,args,accept,0)
 h.service.realClick=async()=>{clicks++}
 await assert.rejects(h.service.followCandidate({url,name},{background:false}),e=>e.code==='NICKNAME_UNREADABLE'&&e.followAttempted!==true)
 assert.equal(clicks,0);assert.equal(h.calls.sent,0)
})

function autoHarness({limit=1,behavior}={}) {
 const storage=createMemoryStorage({contacts:[]}),manager=new CandidateManager(storage)
 const candidates=manager.upsert(['one','two','three'].map(id=>({id,platformUserId:id,nickname:'🌈测试'+id,
  profileUrl:'https://www.douyin.com/user/'+id,libraryIntent:'SEEKING_FRIENDS',status:'DISCOVERED',review:{draftOpening:'fixture hello'},
  source:{type:'comment',topic:'manual_keywords',keyword:'fixture',videoId:'7700000000000000001',commentText:'fixture public comment'}})),{accountId:'default'}).discovery.candidates
 assert.equal(candidates.length,3)
 let state={mode:'auto',riskAcceptedAt:new Date().toISOString(),config:{autoFollow:true,batchAutoLimit:limit,dailyFollowLimit:5,dailyFirstMessageLimit:5,autoMinIntent:'any'},budget:{day:new Date().toISOString().slice(0,10),realFollows:0,realMessages:0}}
 const store={autoContactState:()=>structuredClone(state),setAutoContact:patch=>{state={...state,...patch};return state}}
 const calls=[],friendship={async approachPreview(){return{text:'fixture hello'}},async approach(payload,options){calls.push(payload.url.split('/').at(-1));return behavior(calls.length,payload,options)}}
 const code=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8')
 const start=code.indexOf('  const batchAutoContact = async'),end=code.indexOf('\n  const batchRunnerOf',start)
 const context={libraryStore:()=>store,Date,require:id=>id==='./discovery/batch-contact.cjs'?contact:id==='./discovery/candidate-manager.cjs'?{CandidateManager}:id==='./discovery/batch-contact-service.cjs'?contactService:require(id)}
 const run=vm.runInNewContext(code.slice(start,end)+'\nbatchAutoContact',context)
 return {calls,state:()=>state,manager,run:()=>run({friendship,storage},'default',{id:'fixture-batch',added:candidates.map(c=>({candidateId:c.id}))},()=>{})}
}
const mismatch=(stage='follow',extras={})=>Object.assign(Error('fixture nickname mismatch'),{code:'NICKNAME_UNREADABLE',contactStage:stage,followConfirmed:stage==='greeting',...extras})
test('automatic mode skips a pre-action nickname failure and backfills the unused single-person slot',async()=>{
 const h=autoHarness({behavior:async n=>{if(n===1)throw mismatch();return{ok:true}}})
 const r=await h.run();assert.equal(h.calls.length,2);assert.equal(r.messaged,1);assert.equal(r.identitySkipped,1)
 assert.equal(r.ok,true);assert.equal(h.manager.get().candidates.some(c=>c.review?.realContact?.needsReview||c.action?.needsReview),false)
})
test('automatic mode can skip all unresolved names without globally requiring review or making a send',async()=>{
 const h=autoHarness({behavior:async()=>{throw mismatch()}})
 const r=await h.run();assert.equal(h.calls.length,3);assert.equal(r.code,'IDENTITY_SKIPPED');assert.equal(r.messaged,0)
 assert.equal(h.manager.get().candidates.some(c=>c.review?.realContact?.needsReview||c.action?.needsReview),false)
})
test('a confirmed follow still consumes its per-batch slot even if its nickname blocks the greeting',async()=>{
 const h=autoHarness({limit:1,behavior:async()=>{throw mismatch('greeting')}})
 const r=await h.run();assert.equal(h.calls.length,1);assert.equal(r.followed,1);assert.equal(r.messaged,0)
})
test('a known nickname failure with room left does not stop the rest of the automatic batch',async()=>{
 const h=autoHarness({limit:2,behavior:async n=>{if(n===1)throw mismatch('greeting');return{ok:true}}})
 const r=await h.run();assert.equal(h.calls.length,2);assert.equal(r.messaged,1);assert.equal(r.followed,2)
})
test('an attempted or uncertain send cannot be disguised as a skippable nickname error',async()=>{
 const h=autoHarness({limit:3,behavior:async()=>{throw mismatch('greeting',{sendAttempted:true})}})
 const r=await h.run();assert.equal(h.calls.length,1);assert.equal(r.results[0].needsReview,true);assert.equal(r.results[0].outcome,'UNCERTAIN')
})
test('rate limits, login checks and other failures retain the existing batch-stop behavior',async()=>{
 const h=autoHarness({limit:3,behavior:async()=>{throw Object.assign(Error('操作频繁'),{contactStage:'follow',code:'RATE_LIMITED'})}})
 const r=await h.run();assert.equal(h.calls.length,1);assert.equal(r.code,'RATE_LIMITED')
})

test('automatic mode skips a known pre-send account ID conflict and continues other candidates',async()=>{
 const h=autoHarness({limit:2,behavior:async n=>{if(n===1)throw mismatch('follow',{code:'ACCOUNT_ID_MISMATCH'});return{ok:true}}})
 const result=await h.run();assert.equal(result.messaged,2);assert.equal(result.identitySkipped,1);assert.equal(h.calls.length,3)
})
test('an account ID error after a submit attempt still stops the automatic batch as uncertain',async()=>{
 const h=autoHarness({limit:2,behavior:async()=>{throw mismatch('greeting',{code:'ACCOUNT_ID_MISMATCH',sendAttempted:true})}})
 const result=await h.run();assert.equal(result.results[0].outcome,'UNCERTAIN');assert.equal(h.calls.length,1)
})

test('automatic batch skips a known pre-action page failure and backfills its unused slot',async()=>{
 const h=autoHarness({limit:1,behavior:async n=>{if(n===1)throw Object.assign(Error('page did not load'),{code:'PAGE_NOT_READY',preActionFailure:true,followAttempted:false,sendAttempted:false,contactStage:'follow'});return{ok:true}}})
 const r=await h.run();assert.equal(r.messaged,1);assert.equal(h.calls.length,2);assert.equal(r.results[0].needsReview,false)
})
