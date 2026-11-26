const test=require('node:test'),assert=require('node:assert/strict')
const {createMemoryStorage}=require('./setup.cjs')
const {FriendshipService}=require('../electron/friendship.cjs')
const {DouyinService}=require('../electron/automation.cjs')
const {readInput,writeMessageInput}=require('../electron/message-editor.cjs')
const {contactOne,skippableIdentityFailure}=require('../electron/discovery/batch-contact.cjs')
const name='稳定性测试',url='https://www.douyin.com/user/stability-fixture'
const candidate={id:'candidate',nickname:name,profileUrl:url,platformUserId:'stability-fixture',review:{draftOpening:'fixture hello'},libraryIntent:'SEEKING_FRIENDS'}
function service(){return new FriendshipService({storage:createMemoryStorage({friendship:{followed:[]}}),log(){},emitEvent(){}})}
function page({ready=true,code}={}){
 const calls={main:0,legacy:0,stopped:0},win={isDestroyed:()=>false,show(){},loadURL:()=>new Promise(()=>{}),webContents:{stop(){calls.stopped++},executeJavaScript(){calls.legacy++;throw Error('load-gated legacy executor must not run')},mainFrame:{async executeJavaScript(){calls.main++;return{ready,code,href:url}}}}}
 return {win,calls}
}
test('profile navigation can finish from usable DOM while unrelated resources never finish loading',async()=>{
 const h=page(),s=service();await s.navigate(h.win,url,100);assert.equal(h.calls.main,1);assert.equal(h.calls.legacy,0);assert.equal(h.calls.stopped,0)
})
test('an already usable same-URL profile is reused without a new load that can invalidate its action buttons',async()=>{
 const h=page();h.win.webContents.getURL=()=>url;h.win.loadURL=()=>{throw Error('must not reload a usable same profile')}
 await service().navigate(h.win,url,100);assert.equal(h.calls.main,1);assert.equal(h.calls.stopped,0)
})
test('a failed resource load does not override a verified usable target page',async()=>{
 const h=page();h.win.loadURL=async()=>{throw Error('net::ERR_ABORTED')};await service().navigate(h.win,url,100);assert.equal(h.calls.stopped,0)
})
test('an unreadable page before any action has explicit safe pre-action metadata',async()=>{
 const h=page({ready:false});await assert.rejects(service().navigate(h.win,url,1),e=>e.code==='PAGE_NOT_READY'&&e.preActionFailure===true&&e.followAttempted===false&&e.sendAttempted===false);assert.equal(h.calls.stopped,1)
})
test('visible platform verification remains a stop, never a navigation bypass',async()=>{
 const h=page({ready:false,code:'CHALLENGE'});await assert.rejects(service().navigate(h.win,url,100),e=>e.code==='CHALLENGE_REQUIRED'&&e.blocked===true)
})
test('pausing during DOM-ready navigation still prevents the subsequent real follow action',async()=>{
 const h=page(),s=service();s.adoptCandidate({url,name});s.ensureWindow=()=>h.win
 h.win.webContents.mainFrame.executeJavaScript=async()=>{s.storage.update({automation:{paused:true}});return{ready:true,href:url}}
 await assert.rejects(s.follow(url),/暂停/);assert.equal(h.calls.legacy,0);assert.equal(s.storage.get().friendship.followed.length,0)
})
test('safe navigation failure is saved as not followed and not sent, not unknown delivery',async()=>{
 const h=page({ready:false}),s=service()
 const result=await contactOne(candidate,{friendship:{approach:async()=>{try{await s.navigate(h.win,url,1)}catch(e){e.contactStage='follow';throw e}}}})
 assert.equal(result.outcome,'FAILED');assert.equal(result.followStatus,'not_followed');assert.equal(result.messageStatus,'not_sent');assert.equal(result.needsReview,false);assert.equal(skippableIdentityFailure(result),true)
})
for(const flag of ['sendAttempted','followAttempted','outcomeUncertain'])test(`uncertainty dominates a navigation code if ${flag} is true`,async()=>{
 const error=Object.assign(Error('fixture'),{code:'PAGE_NOT_READY',preActionFailure:true,followAttempted:false,sendAttempted:false,contactStage:'follow',[flag]:true})
 const result=await contactOne(candidate,{friendship:{approach:async()=>{throw error}}});assert.equal(result.outcome,'UNCERTAIN');assert.equal(skippableIdentityFailure(result),false)
})
test('a navigation failure after a confirmed follow keeps the follow but never marks the first message sent',async()=>{
 const error=Object.assign(Error('fixture'),{code:'PAGE_NOT_READY',preActionFailure:true,followAttempted:false,sendAttempted:false,contactStage:'greeting',followConfirmed:true})
 const r=await contactOne(candidate,{friendship:{approach:async()=>{throw error}}});assert.equal(r.followStatus,'confirmed');assert.equal(r.messageStatus,'not_sent');assert.equal(r.needsReview,false)
})

function pendingService({error}={}){
 const s=service(),calls={follow:0,greeting:0}
 s.followCandidate=async()=>{calls.follow++;return{ok:true,followPending:true}}
 s.greetingCandidate=async()=>{calls.greeting++;if(error)throw error;return{ok:true}}
 return {s,calls}
}
test('pending follow still checks the real private panel and can report a confirmed first greeting independently',async()=>{
 const h=pendingService(),r=await h.s.approach({url,name,text:'fixture hello'})
 assert.equal(h.calls.follow,1);assert.equal(h.calls.greeting,1);assert.equal(r.followPending,true);assert.equal(r.messageSent,true)
})
test('pending follow plus confirmed greeting records pending follow and sent message separately',async()=>{
 const h=pendingService(),r=await contactOne(candidate,{friendship:h.s});assert.equal(r.outcome,'SENT');assert.equal(r.followStatus,'pending');assert.equal(r.messageStatus,'sent');assert.equal(r.needsReview,false)
})
test('pending follow with an unavailable private panel stays pending without claiming a sent message',async()=>{
 const h=pendingService({error:Error('私信面板不可用')}),r=await contactOne(candidate,{friendship:h.s});assert.equal(r.outcome,'FOLLOW_PENDING');assert.equal(r.followStatus,'pending');assert.equal(r.messageStatus,'not_sent');assert.match(r.note,/私信面板不可用/)
})
test('pending follow must not swallow an uncertain first-message submission',async()=>{
 const h=pendingService({error:Object.assign(Error('delivery unknown'),{sendAttempted:true})}),r=await contactOne(candidate,{friendship:h.s});assert.equal(r.outcome,'UNCERTAIN');assert.equal(r.followStatus,'pending');assert.equal(r.messageStatus,'unknown');assert.equal(r.needsReview,true)
})
test('legacy pending-only result remains compatible without inventing a confirmed first message',async()=>{
 const r=await contactOne(candidate,{friendship:{approach:async()=>({ok:true,followPending:true})}});assert.equal(r.messageStatus,'not_sent');assert.equal(r.outcome,'FOLLOW_PENDING')
})
test('editor reads use the live main frame while whole-page load is pending',async()=>{
 const h=page();h.win.webContents.mainFrame.executeJavaScript=async()=>({found:true,text:'fixture draft'})
 assert.equal((await readInput(h.win)).text,'fixture draft');assert.equal(h.calls.legacy,0)
})
test('an occupied human draft is preserved during main-frame preparation',async()=>{
 const h=page();h.win.webContents.mainFrame.executeJavaScript=async()=>({found:true,occupied:true,current:'human draft'})
 await assert.rejects(writeMessageInput(h.win,'fixture greeting'),/草稿|内容/);assert.equal(h.calls.legacy,0)
})
test('background verification reads do not recycle a usable main frame due to load-gated execution',async()=>{
 const storage=createMemoryStorage({automation:{autoReply:true,paused:false,sparks:[]},contacts:[]}),ds=new DouyinService({storage,emit(){},ai:{}}),h=page()
 let checked=0,recycled=0;h.win.isVisible=()=>false;h.win.webContents.mainFrame.executeJavaScript=async()=>{checked++;return false}
 ds.window=h.win;ds.getStatus=async()=>({connected:true});ds.recycleChatWindow=()=>{recycled++};ds.syncContacts=async()=>{throw Error('SYNC_REACHED')}
 await assert.rejects(ds.runAutomationInWindow(),/SYNC_REACHED/);assert.equal(checked,1);assert.equal(recycled,0);assert.equal(h.calls.legacy,0)
})
