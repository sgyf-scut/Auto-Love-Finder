const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {FriendshipService,strangerChatSnapshot,activeChatIdentity}=require('../electron/friendship.cjs')
const {browserNicknameTools}=require('../electron/nickname-identity.cjs')
const {contactOne,skippableIdentityFailure}=require('../electron/discovery/batch-contact.cjs')
const name='🌈🌈GK',uid='87184791543',peer='dm-hydration-fixture',url='https://www.douyin.com/user/'+peer
function fixture({title=uid,profile={nickname:name,uid,sec_uid:peer},peerId=peer,alternatePeer=null,opened=true}={}) {
  const rect=()=>({width:100,height:30,left:100,top:100})
  const textNode=value=>({nodeType:3,nodeValue:value})
  const span=value=>({nodeType:1,tagName:'SPAN',innerText:value,textContent:value,childNodes:[textNode(value)],getBoundingClientRect:rect,getAttribute:()=>''})
  const nick=span(name),titleNode=span(title),button={...span('私信'),tagName:'BUTTON',contains:n=>n===button,scrollIntoView(){}}
  const props={curConversation:{toParticipantSecUserId:peerId,_toParticipantSecUserId:alternatePeer||peerId},opponentUserProfile:profile}
  titleNode.__reactPropsFixture=props
  const header={getBoundingClientRect:rect,querySelector:()=>nick,parentElement:{parentElement:{querySelectorAll:()=>[button]}}}
  const editor={isContentEditable:true,tagName:'DIV',innerText:'',focus(){},getAttribute:()=>null,getBoundingClientRect:rect}
  const state={opened,reads:0}
  const document={body:{innerText:''},title:'',defaultView:{},hasFocus:()=>true,
    querySelector:selector=>selector.includes('user-info')?header:editor,
    querySelectorAll(selector){
      if(/captcha|verify/.test(selector))return[]
      if(/StackLayoutStackChatHeadertitle|RightPanelHeadertitle|chat-header-name/.test(selector)){state.reads++;return state.opened?[titleNode]:[]}
      if(selector.includes('contenteditable'))return state.opened?[editor]:[]
      if(selector.includes('button'))return[button]
      return[]
    },elementFromPoint:()=>state.opened?span('overlay'):button}
  const context=vm.createContext({document,location:new URL(url),URL,MouseEvent:class{},getComputedStyle:()=>({display:'block',visibility:'visible'})})
  const run=(fn,args=[])=>vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context)
  return {context,run,props,titleNode,state,editor}
}

test('temporary numeric IM title is bound to the scoped nickname, UID and exact current peer',()=>{
  const r=fixture().run(strangerChatSnapshot,[url,name]);assert.equal(r.ready,true);assert.equal(r.platformUserId,peer)
})
test('current-chat identity supports the same numeric title with corroborated peer and profile',()=>{
  assert.equal(fixture().run(activeChatIdentity,[name]).verified,true)
})
test('a known peer ID remains sufficient while the optional nickname profile is loading',()=>{
  const f=fixture();f.props.opponentUserProfile=null
  const loading=f.run(strangerChatSnapshot,[url,name]);assert.equal(loading.ready,true);assert.equal(loading.platformUserId,peer);assert.equal(loading.wrongPage,undefined)
})
for(const [label,opts] of [
  ['another peer',{peerId:'other'}],
  ['conflicting peer fields',{alternatePeer:'other'}],
  ['same UID but another profile account',{profile:{nickname:name,uid,sec_uid:'other'}}],
])test(`a numeric alias never authorizes ${label}`,()=>{
  const f=fixture(opts);assert.notEqual(f.run(strangerChatSnapshot,[url,name]).ready,true);assert.notEqual(f.run(activeChatIdentity,[name]).verified,true)
})
for(const opts of [
 {profile:{nickname:'other person',uid,sec_uid:peer}},
 {title:'12345678'},
 {title:'another name',profile:{nickname:'another name',uid,sec_uid:peer}},
])test('a verified current account ID takes priority over display-name changes',()=>{
 const f=fixture(opts);assert.equal(f.run(strangerChatSnapshot,[url,name]).ready,true);assert.equal(f.run(activeChatIdentity,[name,peer]).verified,true)
})
test('an alias without an explicit current peer cannot be authorized by a cached profile alone',()=>{
  const f=fixture();f.props.curConversation={}
  assert.notEqual(f.run(strangerChatSnapshot,[url,name]).ready,true);assert.notEqual(f.run(activeChatIdentity,[name]).verified,true)
})
test('an unsafe rounded numeric UID cannot corroborate a title',()=>{
  const tools=browserNicknameTools();assert.equal(tools.uidTitleMatches({nickname:name,uid:9007199254740992},'9007199254740992',name),false)
  assert.equal(tools.uidTitleMatches({nickname:name,uid:Number(uid)},uid,name),true)
})

function harness(options={}) {
  const f=fixture({...options,opened:false}),storage=createMemoryStorage({contacts:[]}),calls={clicks:0,inserted:0,sent:0}
  const win={show(){},isDestroyed:()=>false,webContents:{focus(){},sendInputEvent(){},async insertText(value){calls.inserted++;f.editor.innerText=value},executeJavaScript:async script=>vm.runInContext(script,f.context)}}
  const douyin={storage,lastSent:new Map(),lastSeen:new Map(),lastReplyTime:new Map(),assertCanSend(){},emitEvent(){},log(){},recordSuccessfulSend(){},recordConversationMessage(){},
    async sendCurrentInput(_win,metadata){await metadata.assertTarget();assert.equal(await win.webContents.executeJavaScript(metadata.targetCheckScript),true);calls.sent++}}
  const service=new FriendshipService(douyin);service.ensureWindow=()=>win;service.navigate=async()=>{};service.settle=async()=>{};service.realClick=async()=>{calls.clicks++;f.state.opened=true}
  return {f,storage,service,calls,win}
}
test('a numeric-title first greeting uses one panel click and exactly one simulated submission',async()=>{
  const h=harness();const r=await h.service.greetingCandidate({url,name},'fixture hello')
  assert.equal(r.ok,true);assert.equal(h.calls.clicks,1);assert.equal(h.calls.sent,1);assert.equal(h.storage.get().contacts[0].name,name)
})
test('profile hydration cannot block an already verified current account ID',async()=>{
  const h=harness();const profile=h.f.props.opponentUserProfile;h.f.props.opponentUserProfile=null
  const execute=h.win.webContents.executeJavaScript;let loadingReads=0
  h.win.webContents.executeJavaScript=async script=>{const r=await execute(script);if(r?.reason==='title_loading'){loadingReads++;h.f.props.opponentUserProfile=profile}return r}
  await h.service.greetingCandidate({url,name},'fixture hello')
  assert.equal(loadingReads,0);assert.equal(h.calls.clicks,1);assert.equal(h.calls.sent,1)
})
test('terminal account ID mismatch is preserved instead of being masked by an overlay or second toggle',async()=>{
  const h=harness({peerId:'other-account'})
  await assert.rejects(h.service.greetingCandidate({url,name},'fixture hello'),e=>e.code==='ACCOUNT_ID_MISMATCH'&&!e.message.includes('浮层'))
  assert.equal(h.calls.clicks,1);assert.equal(h.calls.inserted,0);assert.equal(h.calls.sent,0)
})
test('a panel hydration timeout is a known pre-send failure, never an uncertain delivery',async()=>{
  const h=harness();h.f.state.opened=true;h.f.props.opponentUserProfile=null;h.f.props.curConversation={}
  await assert.rejects(h.service.wait(h.win,strangerChatSnapshot,[url,name],r=>r?.ready,0),e=>e.code==='NICKNAME_UNREADABLE'&&e.sendAttempted===false)
  assert.equal(h.calls.sent,0)
})
test('the real mismatch error reaches automatic per-person skip without a synthetic override',async()=>{
  const h=harness({peerId:'other-account'})
  const result=await contactOne({id:'fixture',platformUserId:peer,profileUrl:url,nickname:name,libraryIntent:'SEEKING_FRIENDS',review:{draftOpening:'fixture hello'}},{friendship:{approach:async()=>{
    try{return await h.service.greetingCandidate({url,name},'fixture hello')}catch(e){e.contactStage='greeting';e.followConfirmed=true;throw e}
  }}})
  assert.equal(skippableIdentityFailure(result),true);assert.equal(result.code,'ACCOUNT_ID_MISMATCH');assert.equal(result.messageStatus,'failed');assert.equal(h.calls.sent,0)
})
