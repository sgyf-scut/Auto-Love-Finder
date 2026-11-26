const {test}=require('node:test')
const assert=require('node:assert/strict')
const vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {CommentCollectionService}=require('../electron/discovery/comment-collection-service.cjs')
const {videoCommentsState,openCommentPanel}=require('../electron/discovery/comment-snapshot.cjs')
const videoId='7710857117314103675'

// Run the real method under a virtual clock; tests neither sleep nor open browsers.
function harness(options={}){
 const state={now:0,panel:!!options.open,events:[],reads:0,native:0,scripts:0,detaches:0,releaseAttempts:0}
 const ready=()=>state.now>=(options.readyAt||0)
 const win={isDestroyed:()=>!!options.closed,isVisible:()=>true,show(){},focus(){},webContents:{focus(){},getURL:()=>`https://www.douyin.com/video/${videoId}?private=omitted`,async executeJavaScript(code){
  if(code.includes('function videoCommentsState')){
   state.reads++
   if(options.stateError||state.reads<=(options.transientErrors||0))throw Error('Execution context was destroyed')
   if(options.manualAt!==undefined&&state.now>=options.manualAt)state.panel=true
   if(options.flag)return {[options.flag]:true}
   return {ready:state.panel,panelVisible:state.panel}
  }
  if(code.includes('function openCommentPanel')){
   if(options.entryError)throw Error('Entry script unavailable')
   if(options.entryChallenge)return {challenge:true}
   if(options.entryFailure)return {reason:options.entryFailure,opened:false}
   if(code.includes('"activate":true')){
    state.scripts++;state.events.push({mode:'script',at:state.now})
    if(options.scriptError)throw Error('Activation context changed')
    if(!options.trustedOnly&&ready())state.panel=true
    return {activated:true}
   }
   return {opened:true,source:'comments_tab',point:{x:700,y:320}}
  }
  throw Error('Unexpected page script')
 }}}
 if(options.debugger){
  let attached=!!options.alreadyAttached
  win.webContents.debugger={isAttached:()=>attached,attach(){attached=true},detach(){state.detaches++;attached=false},async sendCommand(method,args){
   if(args.type==='mousePressed'){state.events.push({mode:'debugger',at:state.now});state.native++}
   if(args.type==='mouseReleased'){
    state.releaseAttempts++
    if(options.releaseError&&state.releaseAttempts===1)throw Error('Mouse release failed')
    if(!options.never&&ready())state.panel=true
   }
  }}
 }
 const UnderTest=vm.runInNewContext(`(class {${CommentCollectionService.prototype.ensureCommentPanel.toString()}})`,{
  Date:{now:()=>state.now},sleep:async ms=>{state.now+=ms},
  executePageScript:async(w,code)=>w.webContents.executeJavaScript(code),videoCommentsState,openCommentPanel,
 })
 const service=new UnderTest();service.presentWindow=()=>{}
 service.realClick=async()=>{state.native++;state.events.push({mode:'native',at:state.now});if(options.nativeError)throw Error('Native input failed');if(!options.never&&ready())state.panel=true}
 return {state,win,service,run:()=>service.ensureCommentPanel(win,videoId)}
}

test('late trusted-only handlers still receive a trusted click near the end of the opening window',async()=>{
 const h=harness({readyAt:7000,trustedOnly:true,debugger:true}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.equal(r.openClicks,3)
 assert.deepEqual(h.state.events.map(e=>e.at),[0,4000,8000])
 assert.equal(h.state.events.at(-1).mode,'debugger');assert.ok(h.state.now<10000)
})
test('an immediately functional entry still opens without waiting for later retries',async()=>{
 const h=harness(),r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.native,1);assert.equal(h.state.scripts,0);assert.ok(h.state.now<1000)
})
test('middle script fallback remains available when native input cannot open the panel',async()=>{
 const h=harness({never:true}),r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.native,1);assert.equal(h.state.scripts,1)
})
test('an unresponsive page has at most three attempts and a ten-second opening deadline',async()=>{
 const h=harness({never:true,trustedOnly:true}),r=await h.run();assert.equal(r.panelOpened,false);assert.equal(r.openClicks,3);assert.equal(r.openFailure,'panel_open_timeout');assert.equal(h.state.now,10000)
 assert.equal(r.openDiagnostics.attempts,3);assert.equal(r.openDiagnostics.entrySource,'comments_tab')
 assert.equal(r.openDiagnostics.currentPage,`https://www.douyin.com/video/${videoId}`)
})
test('an already open panel is never toggled by the retry policy',async()=>{
 const h=harness({open:true}),r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.events.length,0)
})
test('a user opening the panel during the wait cancels the remaining click',async()=>{
 const h=harness({never:true,trustedOnly:true,manualAt:5000}),r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.events.length,2);assert.equal(h.state.now,5000)
})
for(const reason of ['entry_obscured','ambiguous_entry'])test(`${reason} retains its specific failure with zero clicks`,async()=>{
 const h=harness({entryFailure:reason}),r=await h.run();assert.equal(r.panelOpened,false);assert.equal(r.openFailure,reason);assert.equal(r.openClicks,0);assert.equal(h.state.events.length,0)
})
test('persistent script failures retain the original error and do not authorize any click',async()=>{
 const h=harness({stateError:true}),r=await h.run();assert.equal(r.openFailure,'script_execution_failed');assert.equal(r.openClicks,0)
 assert.equal(r.openDiagnostics.lastScriptError,'Execution context was destroyed');assert.equal(r.openDiagnostics.lastErrorPhase,'state_read')
 assert.ok(r.openDiagnostics.scriptErrors>0);assert.ok(r.openDiagnostics.events.length<=12);assert.equal(h.state.events.length,0)
})
test('temporary context loss recovers within the same bounded opening operation',async()=>{
 const h=harness({transientErrors:2}),r=await h.run();assert.equal(r.panelOpened,true);assert.equal(r.openDiagnostics.scriptErrors,2);assert.equal(h.state.native,1)
})
test('entry-script failure is distinguished from an entry that was clicked but did not open',async()=>{
 const h=harness({entryError:true}),r=await h.run();assert.equal(r.openFailure,'script_execution_failed');assert.equal(r.openClicks,0);assert.equal(r.openDiagnostics.lastErrorPhase,'entry_read')
})
for(const flag of ['challenge','wrongPage','loginRequired'])test(`${flag} stops before dispatching comment input`,async()=>{
 const h=harness({flag}),r=await h.run();assert.equal(r[flag],true);assert.equal(h.state.events.length,0)
})
test('a challenge detected while locating the entry stops all clicks',async()=>{
 const h=harness({entryChallenge:true}),r=await h.run();assert.equal(r.challenge,true);assert.equal(h.state.events.length,0)
})
test('closed windows return a distinct terminal result',async()=>{
 const h=harness({closed:true}),r=await h.run();assert.equal(r.windowClosed,true);assert.equal(h.state.reads,0)
})
test('native and script activation failures consume a bounded attempt budget',async()=>{
 const h=harness({nativeError:true,scriptError:true}),r=await h.run();assert.equal(r.openFailure,'click_dispatch_failed');assert.equal(r.openClicks,0);assert.equal(r.openDiagnostics.attempts,3);assert.equal(r.openDiagnostics.clickErrors,2)
})
test('partial debugger dispatch never triggers an extra native click or detaches someone else’s debugger',async()=>{
 const h=harness({never:true,trustedOnly:true,debugger:true,alreadyAttached:true,releaseError:true})
 // A partially delivered debugger click may succeed during its best-effort release.
 await h.run();assert.equal(h.state.events.filter(e=>e.mode==='native').length,1);assert.equal(h.state.releaseAttempts,2);assert.equal(h.state.detaches,0)
})
test('transport reports zero-click script failure accurately and preserves diagnostics',async()=>{
 const h=harness({stateError:true}),opened=await h.run()
 const service=new CommentCollectionService({storage:createMemoryStorage(),partition:'fixture'})
 service.ensureWindow=()=>h.win;service.ensureCommentPanel=async()=>opened
 const result=await service.createTransport().readPage({videoId})
 assert.equal(result.code,'COMMENTS_UNAVAILABLE');assert.equal(result.diagnostics.attempts,0)
 assert.match(result.reason,/尚未执行展开点击/);assert.match(result.reason,/Execution context was destroyed/)
 assert.doesNotMatch(result.reason,/已尝试打开/)
})
