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

const {requestManualVerification}=require('../electron/manual-verification.cjs')
const {resolveGreetingContact,archiveConfirmedGreeting}=require('../electron/confirmed-greeting.cjs')
const {BatchRunner}=require('../electron/discovery/batch-runner.cjs')
const {CommentCollectionService}=require('../electron/discovery/comment-collection-service.cjs')
const {VideoSources}=require('../electron/discovery/video-sources.cjs')
const id='identity-fixture'

test('an existing synchronized contact with matching platform ID needs no autoFriendshipUrl',async()=>{
 const h=greetingHarness();h.storage.update({contacts:[{id:'synced',name,profile:{platformUserId:id,dmIdentityVerified:true},learning:{messages:[]}}]})
 const r=await h.service.greetingCandidate({url,name},'fixture message')
 assert.equal(r.ok,true);assert.equal(r.contactId,'synced');assert.equal(r.deliveryStatus,'confirmed');assert.equal(h.calls.sent,1);assert.equal(h.calls.quota,1)
 assert.equal(h.storage.get().contacts.length,1);assert.equal(h.storage.get().contacts[0].profile.autoFriendshipUrl,url)
})
for(const existing of [
 {id:'unbound',name,profile:{}},
 {id:'other-account',name,profile:{platformUserId:'different-person'}},
])test(`confirmed delivery survives contact conflict without merging ${existing.id}`,async()=>{
 const h=greetingHarness();h.storage.update({contacts:[existing]});const before=h.storage.get().contacts
 const r=await h.service.greetingCandidate({url,name},'fixture message')
 assert.equal(r.ok,true);assert.equal(r.messageSent,true);assert.equal(r.deliveryStatus,'confirmed');assert.equal(r.contactSyncPending,true);assert.equal(h.calls.sent,1)
 assert.deepEqual(h.storage.get().contacts,before);assert.match(r.warning,/无需重发|请勿重发/)
})
test('matching ID with conflicting stored profile URL is never silently rebound',()=>{
 const c={name,profile:{platformUserId:id,autoFriendshipUrl:'https://www.douyin.com/user/other'}}
 assert.throws(()=>resolveGreetingContact([c],{url,name}),e=>e.code==='CONTACT_ARCHIVE_CONFLICT')
})
test('duplicate bindings for one account remain a local archive conflict',()=>{
 assert.throws(()=>resolveGreetingContact([{name,profile:{platformUserId:id}},{name:'other',profile:{platformUserId:id}}],{url,name}),/身份冲突/)
})
test('archive failure does not falsify a known delivery or retry sending',()=>{
 let archives=0;const r=archiveConfirmedGreeting({douyin:{log(){}}},{url,name},()=>{archives++;throw Error('disk fixture')})
 assert.equal(archives,1);assert.equal(r.messageSent,true);assert.equal(r.contactSyncPending,true);assert.equal(r.contactId,null)
})
test('an uncertain platform submission is still uncertain and does not archive a contact',async()=>{
 const h=greetingHarness();h.service.douyin.sendCurrentInput=async()=>{h.calls.sent++;throw Error('confirmation unavailable')}
 await assert.rejects(h.service.greetingCandidate({url,name},'fixture message'),e=>e.sendAttempted===true)
 assert.equal(h.calls.sent,1);assert.equal(h.calls.quota,0);assert.deepEqual(h.storage.get().contacts,[])
})
test('wrong recipient remains blocked before typing or delivery',async()=>{
 const h=greetingHarness({peer:'another-account'})
 await assert.rejects(h.service.greetingCandidate({url,name},'fixture message'))
 assert.equal(h.calls.inserted,0);assert.equal(h.calls.sent,0)
})
test('batch result preserves confirmed delivery plus archive warning without demanding delivery review',async()=>{
 const candidate={id:'c',nickname:name,profileUrl:url,platformUserId:id,libraryIntent:'SEEKING_FRIENDS'}
 const r=await contact.contactOne(candidate,{text:'fixture',friendship:{approach:async()=>({ok:true,messageSent:true,contactSyncPending:true,warning:'归档待处理，请勿重发'})}})
 assert.equal(r.messageStatus,'sent');assert.equal(r.outcome,'SENT');assert.equal(r.needsReview,false);assert.equal(r.contactSyncPending,true);assert.match(r.note,/归档/)
 assert.equal(contact.preflight({...candidate,review:{realContact:r}}).code,'ALREADY_SENT')
})

test('manual verification shows a prompt and does not submit any interaction',async()=>{
 const events=[],prompts=[],shown=[];const douyin={log:(...args)=>events.push(args)},win={isDestroyed:()=>false,show:()=>shown.push('show'),focus(){}}
 assert.equal(requestManualVerification(douyin,win,{now:1,dialog:{showMessageBox:async(parent,options)=>{prompts.push(options);assert.equal(parent,win)}}}),true)
 assert.equal(events[0][0],'verification_required');assert.equal(prompts.length,1);assert.match(prompts[0].detail,/手动完成/);assert.deepEqual(prompts[0].buttons,['知道了']);assert.equal(shown.length,1)
 await new Promise(setImmediate)
 assert.equal(requestManualVerification(douyin,win,{now:2,dialog:{showMessageBox(){throw Error('duplicate prompt')}}}),false)
})
test('an open verification prompt is not duplicated even after cooldown',async()=>{
 const d={},dialog={showMessageBox:()=>new Promise(()=>{})}
 assert.equal(requestManualVerification(d,null,{now:1,dialog}),true);assert.equal(requestManualVerification(d,null,{now:100000,dialog}),false)
})
test('verification notifications are isolated by account',()=>{
 let n=0;const dialog={showMessageBox(){n++;return Promise.resolve()}}
 requestManualVerification({},null,{dialog});requestManualVerification({},null,{dialog});assert.equal(n,2)
})
test('an unavailable native dialog does not hide the in-app verification log',()=>{
 let logged=0;assert.equal(requestManualVerification({log(){logged++}},null,{dialog:{}}),true);assert.equal(logged,1)
})
for(const source of ['keyword','hashtag'])test(`verification in ${source} search stops before another source or contact hook`,async()=>{
 let queried=0,contacted=0
 const storage=createMemoryStorage(),manager=new CandidateManager(storage),runner=new BatchRunner({storage,manager,libraryStore:{read:()=>({videos:[],comments:[]})},
 sourcesFactory:()=>({collectByKeyword:async()=>{queried++;return{ok:false,kind:'CHALLENGE',videos:[],events:[]}},collectByTag:async()=>{queried++;return{ok:false,kind:'CHALLENGE',videos:[],events:[]}}}),onBatchDone:async()=>{contacted++}})
 const r=await runner.start({sources:source==='keyword'?{keywords:['first','second'],tags:['third']}:{tags:['first','second']}})
 assert.equal(queried,1);assert.equal(contacted,0);assert.equal(r.batch.stopCode,'CHALLENGE');assert.equal(r.batch.status,'paused');assert.match(r.batch.reason,/手动完成/)
})
test('a challenge opening the comment panel returns immediately instead of waiting until the video timeout',async()=>{
 const d={storage:createMemoryStorage(),log(){},emitEvent(){}},s=new CommentCollectionService(d)
 const win={isDestroyed:()=>false,show(){},focus(){},webContents:{}};s.ensureWindow=()=>win;s.ensureCommentPanel=async()=>({challenge:true});s.waitForVerification=()=>{throw Error('must not consume the per-video time budget')}
 const start=Date.now(),result=await s.createTransport().readPage({videoId:'12345678'})
 assert.equal(result.code,'CHALLENGE');assert.ok(Date.now()-start<1000)
})
test('a visible search challenge does not call an API or fallback reader',async()=>{
 let logs=0;const win={isDestroyed:()=>false,show(){},focus(){},webContents:{executeJavaScript:async()=>({code:'CHALLENGE'})}}
 const s=new VideoSources({douyin:{log(){logs++}},ensureWindow:()=>win});s.evalInPage=()=>{throw Error('must stop')}
 const result=await s.requestVideos(()=>{}, {},'https://www.douyin.com/search/test?type=video')
 assert.equal(result.kind,'CHALLENGE');assert.equal(logs,1)
})
test('a challenge during follow confirmation is not treated as a reason for another follow click',async()=>{
 const h=greetingHarness();let clicks=0,calls=0
 h.service.wait=async()=>{calls++;if(calls===1)return{ready:true,canFollow:true};throw Object.assign(Error('fixture verification'),{blocked:true,code:'CHALLENGE_REQUIRED'})}
 h.service.realClick=async()=>{clicks++};h.f.run(profileSnapshot,[url,false,name])
 // Model the live follow-control probe; the browser stub returns the same exact identity.
 const old=h.service.ensureWindow().webContents.executeJavaScript
 h.service.ensureWindow().webContents.executeJavaScript=async code=>code.includes('profileSnapshot')?{ready:true,point:{x:10,y:10},hitSelf:true}:old(code)
 await assert.rejects(h.service.followCandidate({url,name},{background:false}),e=>e.blocked&&e.followAttempted===true)
 assert.equal(clicks,1)
})
