const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {CommentCollectionService}=require('../electron/discovery/comment-collection-service.cjs')
const {videoCommentsState,openCommentPanel}=require('../electron/discovery/comment-snapshot.cjs')
const id='7711224680274914762'
function harness({loadedAt=0,entryAt=0,handlerAt=0,bufferForever=false,initiallyOpen=false,flag=null,flagAt=0,closedAt=Infinity,layoutChangeAt=null}={}){
 const state={now:0,panel:initiallyOpen,clicks:[],phases:[]}
 const click=mode=>{state.clicks.push({at:state.now,mode});if(state.now>=handlerAt)state.panel=true}
 const win={isDestroyed:()=>state.now>=closedAt,isVisible:()=>true,show(){},focus(){},webContents:{focus(){},getURL:()=>`https://www.douyin.com/video/${id}`,async executeJavaScript(code){
  if(code.includes('function videoCommentsState')){
   if(flag&&state.now>=flagAt)return {[flag]:true}
   return {ready:state.panel,panelVisible:state.panel,pageLoading:bufferForever||state.now<loadedAt,mediaBuffering:bufferForever||state.now<loadedAt,...(layoutChangeAt!==null?{documentState:'complete'}:{})}
  }
  if(code.includes('function openCommentPanel')){
   if(state.now<entryAt)return {opened:false,reason:'entry_not_ready'}
   if(code.includes('"activate":true')){state.clicks.push({at:state.now,mode:'script'});return {activated:true}}
   return {opened:true,source:'comment_icon',point:{x:layoutChangeAt!==null&&state.now>=layoutChangeAt?620:600,y:450}}
  }
  throw Error('Unexpected script')
 }}}
 let attached=false
 win.webContents.debugger={isAttached:()=>attached,attach(){attached=true},detach(){attached=false},async sendCommand(method,args){if(args.type==='mouseReleased')click('trusted')}}
 const UnderTest=vm.runInNewContext(`(class {${CommentCollectionService.prototype.ensureCommentPanel.toString()}})`,{Date:{now:()=>state.now},sleep:async ms=>{state.now+=ms},executePageScript:(w,code)=>w.webContents.executeJavaScript(code),videoCommentsState,openCommentPanel})
 const service=new UnderTest();service.presentWindow=()=>{};service.realClick=async()=>click('native')
 return {state,win,service,run:()=>service.ensureCommentPanel(win,id,{onPhase:phase=>state.phases.push(phase)})}
}
test('a video that loads after twelve seconds retains a full opening window and late trusted retry',async()=>{
 const h=harness({loadedAt:12000,handlerAt:18000}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.ok(h.state.now>=18000&&h.state.now<22000)
 assert.equal(h.state.clicks.length,3);assert.equal(h.state.clicks.at(-1).mode,'trusted')
 assert.ok(r.openDiagnostics.loadingWaitMs>=12000);assert.ok(r.openDiagnostics.openingWaitMs<10000)
 assert.match(h.state.phases[0],/仍在加载/);assert.match(h.state.phases.at(-1),/展开评论/)
})
test('an entry that appears only after a fourteen-second render is not skipped at ten seconds',async()=>{
 const h=harness({loadedAt:14000,entryAt:14000,handlerAt:14000}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.equal(h.state.clicks.length,1);assert.ok(h.state.now>=14000)
})
test('comments usable during permanent video buffering are read without waiting for playback',async()=>{
 const h=harness({bufferForever:true}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.equal(h.state.clicks.length,1);assert.ok(h.state.now<=1500)
})
test('an already visible list bypasses even a permanently buffering player with no clicks',async()=>{
 const h=harness({bufferForever:true,initiallyOpen:true}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.equal(h.state.now,0);assert.equal(h.state.clicks.length,0)
})
test('permanent page loading has a thirty-second cap and at most three spaced probes',async()=>{
 const h=harness({bufferForever:true,handlerAt:Infinity}),r=await h.run()
 assert.equal(r.panelOpened,false);assert.equal(r.openFailure,'page_load_timeout');assert.equal(h.state.now,30000)
 assert.equal(h.state.clicks.length,3);assert.equal(r.empty,undefined)
})
test('a slow loaded but unresponsive page stops after the separate ten-second opening budget',async()=>{
 const h=harness({loadedAt:24000,handlerAt:Infinity}),r=await h.run()
 assert.equal(r.panelOpened,false);assert.equal(r.openFailure,'panel_open_timeout');assert.equal(h.state.now,34000)
 assert.equal(r.openDiagnostics.loadingWaitMs,24000);assert.equal(r.openDiagnostics.openingWaitMs,10000)
})
for(const flag of ['challenge','wrongPage','loginRequired'])test(`${flag} during a long render interrupts immediately without later retries`,async()=>{
 const h=harness({loadedAt:25000,handlerAt:Infinity,flag,flagAt:14000}),r=await h.run()
 assert.equal(r[flag],true);assert.equal(h.state.now,14000);assert.equal(h.state.clicks.length,2)
})
test('closing a slow-loading window cancels without waiting thirty seconds',async()=>{
 const h=harness({bufferForever:true,handlerAt:Infinity,closedAt:3000}),r=await h.run()
 assert.equal(r.windowClosed,true);assert.equal(h.state.now,3000)
})
test('transport reports a loading timeout distinctly and retains the measured loading budget',async()=>{
 const h=harness({bufferForever:true,handlerAt:Infinity}),opened=await h.run()
 const service=new CommentCollectionService({storage:createMemoryStorage(),partition:'fixture'})
 service.ensureWindow=()=>h.win;service.ensureCommentPanel=async()=>opened
 const r=await service.createTransport().readPage({videoId:id})
 assert.equal(r.code,'TIMEOUT');assert.equal(r.diagnostics.failure,'page_load_timeout');assert.equal(r.diagnostics.loadingWaitMs,30000)
 assert.match(r.reason,/持续加载/);assert.doesNotMatch(r.reason,/没有评论/)
})
function snapshot({buffering=false,busy=false,panel=false,documentState='complete'}={}){
 const node={getBoundingClientRect:()=>({width:100,height:100}),innerText:'加载中',readyState:buffering?0:4,error:null}
 return vm.runInNewContext(`(${videoCommentsState.toString()})('${id}')`,{location:{origin:'https://www.douyin.com',href:`https://www.douyin.com/video/${id}`},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{title:'测试作品',readyState:documentState,body:{innerText:'测试作品'},querySelectorAll(selector){
  if(selector==='video')return [node]
  if(selector==='[data-e2e="comment-list"]')return panel?[node]:[]
  if(selector.includes('xgplayer-loading'))return busy?[node]:[]
  return []
 }}})
}
test('a rendered title with an unbuffered video remains a loading page',()=>{const s=snapshot({buffering:true});assert.equal(s.pageLoading,true);assert.equal(s.ready,false)})
test('a visible player loader keeps the separate loading budget active',()=>{assert.equal(snapshot({busy:true}).pageLoading,true)})
test('an open comment list takes precedence over media and player loaders',()=>{const s=snapshot({buffering:true,busy:true,panel:true});assert.equal(s.pageLoading,false);assert.equal(s.panelVisible,true)})
test('a ready player does not add a fixed thirty-second delay',async()=>{assert.equal(snapshot({}).pageLoading,false);const h=harness(),r=await h.run();assert.equal(r.panelOpened,true);assert.ok(h.state.now<1000)})

test('an absent comment entry gets render time even when the video claims it is ready',async()=>{
 const h=harness({entryAt:18000,handlerAt:18000}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.ok(h.state.now>=18000);assert.equal(h.state.clicks.length,1)
})
test('a permanently absent entry ends as an entry-render timeout with zero clicks',async()=>{
 const h=harness({entryAt:Infinity}),r=await h.run()
 assert.equal(r.openFailure,'entry_render_timeout');assert.equal(h.state.now,30000);assert.equal(h.state.clicks.length,0)
})
test('a shifted entry gets stable layout and a fresh opening budget under the total deadline',async()=>{
 const h=harness({layoutChangeAt:7000,handlerAt:14000}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.ok(h.state.now>=14000&&h.state.now<18000);assert.equal(h.state.clicks.length,3)
})
test('video buffering cannot suppress the later trusted probe when comments become usable',async()=>{
 const h=harness({bufferForever:true,handlerAt:8000}),r=await h.run()
 assert.equal(r.panelOpened,true);assert.ok(h.state.now>=8000&&h.state.now<12000);assert.equal(h.state.clicks.length,2)
})
