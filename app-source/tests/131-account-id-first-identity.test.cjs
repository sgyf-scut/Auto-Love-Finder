const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {browserNicknameTools}=require('../electron/nickname-identity.cjs')
const {profileSnapshot,strangerChatSnapshot,activeChatIdentity,contactActionsSnapshot}=require('../electron/friendship.cjs')
const {DouyinService,conversationIdentityScript,conversationRowScript}=require('../electron/automation.cjs')
const tools=browserNicknameTools(),id='account-id-fixture',url='https://www.douyin.com/user/'+id,name='🌈小雨Ly1'
const rect=()=>({width:150,height:30,left:300,top:30,x:300,y:30})
const span=value=>({nodeType:1,tagName:'SPAN',innerText:value,textContent:value,childNodes:[{nodeType:3,nodeValue:value}],getBoundingClientRect:rect,getAttribute:()=>''})
function row(label,peer='',active=false){
 const title=span(label)
 return {name:label,children:[],className:active?'active':'',getAttribute:()=>'',getBoundingClientRect:rect,querySelector:()=>title,querySelectorAll:()=>[],
   __reactPropsFixture:peer?{curConversation:{toParticipantSecUserId:peer}}:{}}
}
function fixture({title=name,profileName=name,peer=id,profileId=id,rows=[],incomplete=false,profileProof=true,opponentProfile=null}={}){
 const heading=span(profileName),chat=span(title),controls=['已关注','私信'].map(s=>({...span(s),contains:()=>false}))
 if(incomplete)heading.childNodes=[{nodeType:1,tagName:'IMG',getAttribute:()=>'',alt:''},{nodeType:3,nodeValue:'小雨Ly1'}]
 const header={getBoundingClientRect:rect,querySelector:()=>heading,parentElement:{parentElement:{querySelectorAll:()=>controls}}}
 if(profileProof)header.__reactPropsFixture={userInfo:{nickname:profileName,sec_uid:profileId}}
 chat.__reactPropsFixture={curConversation:peer?{toParticipantSecUserId:peer}:{},opponentUserProfile:opponentProfile}
 const editor={...span(''),isContentEditable:true,focus(){}}
 const doc={body:{innerText:''},defaultView:{},
  querySelector:s=>s.includes('user-info')?header:s.includes('contenteditable')?editor:s.includes('conversationConversationListwrapper')?(rows.length?{querySelectorAll:()=>rows}:null):null,
  querySelectorAll(s){if(/captcha|verify/.test(s))return[];if(s.includes('conversationConversationItemwrapper'))return rows;if(/ChatHeadertitle|chat-header|chatHeaderTitle|imChatHeadertitle/.test(s))return[chat];if(s.includes('contenteditable'))return[editor];if(s.includes('user-info-follow-btn'))return[controls[0]];return[]}}
 const context=vm.createContext({document:doc,location:new URL(url),URL,getComputedStyle:()=>({display:'block',visibility:'visible'})})
 const run=(fn,args=[])=>vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context)
 return {context,run,chat,header,doc}
}

for(const [a,b] of [['🌈小雨Ly1','☀️小雨Ly1'],['小 雨（Ly1）','小雨Ly1'],['Cafe\u0301✨','Café']])
 test(`comparison name ignores decoration: ${a}`,()=>assert.equal(tools.compareNames(a,b),'DECORATION_ONLY'))
for(const [a,b] of [['小雨1','小雨2'],['小雨Ly','小雨LY'],['Ａlice','Alice'],['🌈','☀️']])
 test(`comparison name does not erase identity-bearing text: ${a}`,()=>assert.equal(tools.compareNames(a,b),'DIFFERENT'))

for(const displayedName of ['☀小雨Ly1','全新的名字','87184791543','','🌈🌈'])test(`verified account ID takes priority over displayed nickname: ${displayedName||'empty'}`,()=>{
 const d=tools.decide({expectedId:id,observedIds:[id],expectedName:name,displayedName});assert.equal(d.verified,true);assert.equal(d.source,'account_id')
})
test('a similar stripped name without account ID cannot authorize a send',()=>{
 const d=tools.decide({expectedId:id,observedIds:[],expectedName:name,displayedName:'☀小雨Ly1'});assert.equal(d.nameMatch,'DECORATION_ONLY');assert.equal(d.state,'PENDING');assert.equal(d.verified,false)
})
test('an exact nickname cannot override a different or contradictory ID',()=>{
 for(const ids of [['other'],[id,'other']]){const d=tools.decide({expectedId:id,observedIds:ids,expectedName:name,displayedName:name});assert.equal(d.state,'MISMATCH');assert.equal(d.verified,false)}
})
test('an absent or malformed expected ID never binds a contact by its name',()=>{
 for(const expectedId of ['',null,'invalid id'])assert.equal(tools.decide({expectedId,observedIds:[id],expectedName:name,displayedName:name}).verified,false)
})

for(const title of ['☀小雨Ly1','改过昵称了','87184791543','🌈🌈'])test(`serialized current-panel proof accepts the correct ID with ${title}`,()=>{
 const f=fixture({title});assert.equal(f.run(activeChatIdentity,[name,id]).verified,true);assert.equal(f.run(strangerChatSnapshot,[url,name]).ready,true)
 assert.equal(vm.runInContext(conversationIdentityScript(name,id),f.context).isTargetMatch,true)
})
test('symbol-only nickname remains usable when the current account ID is verified',()=>{
 const f=fixture({title:'🌈',profileName:'🌈'});assert.equal(f.run(activeChatIdentity,['🌈',id]).verified,true)
 assert.equal(tools.comparisonName('🌈'),'')
})
test('incomplete image alt does not veto a verified profile account ID',()=>{
 const f=fixture({incomplete:true});assert.equal(f.run(profileSnapshot,[url,false,name]).ready,true);assert.equal(f.run(contactActionsSnapshot,[url,name]).identityVerified,true)
})
test('a renamed profile is verified by its scoped account ID even if its heading is still stale',()=>{
 const f=fixture({profileName:'新名字'});f.header.__reactPropsFixture.userInfo.nickname='另一个加载阶段的名字'
 assert.equal(f.run(profileSnapshot,[url,false,name]).ready,true)
})
test('a profile ID mismatch still blocks when both names collapse to the same comparison name',()=>{
 const f=fixture({profileName:'☀小雨Ly1',profileId:'other'});assert.equal(f.run(profileSnapshot,[url,false,name]).wrongRecipient,true)
})
test('a stripped profile-name match alone waits for ID instead of clicking follow',()=>{
 const f=fixture({profileName:'☀小雨Ly1',profileProof:false});const d=f.run(profileSnapshot,[url,true,name]);assert.equal(d.ready,false);assert.equal(d.reason,'identity_loading');assert.equal(d.point,undefined)
})
test('current conversation ID can verify an already open panel while the optional profile name loads',()=>{
 const f=fixture({profileName:'暂未同步的名称',profileProof:false,title:'☀小雨Ly1'});assert.equal(f.run(strangerChatSnapshot,[url,name]).ready,true)
})
test('cached opponent profile alone cannot replace a missing current conversation ID',()=>{
 const f=fixture({peer:'',opponentProfile:{nickname:name,sec_uid:id}});const d=f.run(activeChatIdentity,[name,id]);assert.equal(d.verified,false);assert.equal(d.state,'PENDING')
})
test('a same-name profile with another ID contradicts the current panel',()=>{
 const f=fixture({opponentProfile:{nickname:name,sec_uid:'other'}});assert.equal(f.run(activeChatIdentity,[name,id]).state,'MISMATCH')
})
test('a differently named stale profile does not override a verified current peer',()=>{
 const f=fixture({opponentProfile:{nickname:'完全无关的旧联系人',sec_uid:'other'}});assert.equal(f.run(activeChatIdentity,[name,id]).verified,true)
})
test('same comparison name on a different current peer cannot authorize sending',()=>{
 const f=fixture({title:'☀小雨Ly1',peer:'other'});assert.equal(f.run(activeChatIdentity,[name,id]).state,'MISMATCH');assert.equal(vm.runInContext(conversationIdentityScript(name,id),f.context).isTargetMatch,false)
})
test('legacy unbound callers retain strict names and cannot authorize stripped-name collisions',()=>{
 const f=fixture({title:'☀小雨Ly1'});assert.equal(f.run(activeChatIdentity,[name]).verified,false);assert.equal(vm.runInContext(conversationIdentityScript(name),f.context).isTargetMatch,false)
})
test('a stale selected row cannot veto the verified ID of the actual open panel',()=>{
 const f=fixture({title:'新昵称',rows:[row('旧选中项','other',true)]});assert.equal(vm.runInContext(conversationIdentityScript(name,id),f.context).isTargetMatch,true)
})
test('an exact selected row cannot rescue the wrong actual open panel',()=>{
 const f=fixture({peer:'other',rows:[row(name,id,true)]});assert.equal(vm.runInContext(conversationIdentityScript(name,id),f.context).isTargetMatch,false)
})
test('multiple visible headers remain ambiguous even with a matching ID',()=>{
 const f=fixture(),read=f.doc.querySelectorAll;f.doc.querySelectorAll=s=>/ChatHeadertitle|chat-header|chatHeaderTitle/.test(s)?[f.chat,{...f.chat}]:read(s)
 assert.equal(f.run(activeChatIdentity,[name,id]).verified,false)
})

function select(rows,target=name,expected=id){const f=fixture({rows});return vm.runInContext(conversationRowScript(target,expected),f.context)}
test('row lookup prefers the account ID even after a complete nickname change',()=>{
 const wanted=row('全新昵称',id),wrong=row(name,'other');assert.equal(select([wrong,wanted]),wanted)
})
test('a unique stripped-name row is only selected for inspection when its ID is not known',()=>{
 const unknown=row('☀小雨Ly1');assert.equal(select([unknown]),unknown)
})
test('a row with a contradictory ID is never selected via a similar name',()=>assert.equal(select([row('☀小雨Ly1','other')]),null))
test('colliding stripped names never arbitrarily select one of two unknown accounts',()=>assert.equal(select([row('☀小雨Ly1'),row('✨小雨Ly1')]),null))
test('digits are retained when locating an unknown candidate row',()=>assert.equal(select([row('☀小雨Ly2')]),null))
test('symbol-only names cannot produce an empty-key match to another account',()=>assert.equal(select([row('☀')],'🌈'),null))
test('two rows claiming the same expected ID remain ambiguous',()=>assert.equal(select([row(name,id),row('改名',id)]),null))
test('unbound legacy lookup does not broaden to stripped-name matching',()=>assert.equal(select([row('☀小雨Ly1')],name,''),null))

test('the real conversation selector opens a renamed ID-bound row and the real send guard accepts it',async()=>{
 const wanted=row('改过的显示名',id),other=row(name,'other'),f=fixture({title:'当前其他会话',peer:'other',rows:[other,wanted]})
 wanted.scrollIntoView=()=>{};other.scrollIntoView=()=>{}
 let clicks=0
 const win={isDestroyed:()=>false,webContents:{executeJavaScript:async script=>vm.runInContext(script,f.context),sendInputEvent(event){if(event.type!=='mouseUp')return;clicks++;f.chat.__reactPropsFixture.curConversation={toParticipantSecUserId:id};f.chat.innerText='改过的显示名';f.chat.childNodes=[{nodeType:3,nodeValue:'改过的显示名'}]}}}
 const service={storage:createMemoryStorage({contacts:[{id:'contact-fixture',name,profile:{platformUserId:id}}]}),waitForChatReady:async()=>win,backgroundNavigationBlocked:()=>false,assertChatOperationActive(){},withChatRead:operation=>operation()}
 assert.equal(await DouyinService.prototype.selectConversationCore.call(service,name),win)
 assert.equal(clicks,1)
 assert.equal((await DouyinService.prototype.assertConversationTarget.call(service,win,name)).platformUserId,id)
})
test('the real final send guard rejects an equally named but different account',async()=>{
 const f=fixture({title:name,peer:'other'}),win={webContents:{executeJavaScript:async script=>vm.runInContext(script,f.context)}}
 const service={storage:createMemoryStorage({contacts:[{id:'contact-fixture',name,profile:{platformUserId:id}}]}),backgroundNavigationBlocked:()=>false,assertChatOperationActive(){},withChatRead:operation=>operation()}
 await assert.rejects(DouyinService.prototype.assertConversationTarget.call(service,win,name),e=>e.code==='ACCOUNT_ID_MISMATCH'&&e.message.includes('阻止错发'))
})
test('a bound account with loading identity reports pending instead of blaming its nickname',async()=>{
 const f=fixture({peer:''}),win={webContents:{executeJavaScript:async script=>vm.runInContext(script,f.context)}}
 const service={storage:createMemoryStorage({contacts:[{id:'contact-fixture',name,profile:{platformUserId:id}}]}),backgroundNavigationBlocked:()=>false,assertChatOperationActive(){},withChatRead:operation=>operation()}
 await assert.rejects(DouyinService.prototype.assertConversationTarget.call(service,win,name),e=>e.code==='ACCOUNT_ID_PENDING'&&!e.message.includes('昵称'))
})
