const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {CommentCollectionService}=require('../electron/discovery/comment-collection-service.cjs')
const {openCommentPanel}=require('../electron/discovery/comment-snapshot.cjs')
const {pageReadinessSnapshot}=require('../electron/discovery/page-readiness.cjs')
const id='7710089666623789541',url='https://www.douyin.com/video/'+id
function panelDom({rows=false,list=false,tabs=[],hit=null}={}){
 const context={location:{origin:'https://www.douyin.com',href:url},getComputedStyle:()=>({display:'block',visibility:'visible'}),innerHeight:900,innerWidth:1200,
  document:{title:'作品页',querySelectorAll(s){if(s.includes('verifycenter')||s==='video')return[];if(s==='[data-e2e="comment-item"]')return rows?[node('comment')]:[];if(s==='[data-e2e="comment-list"]')return list?[node('list')]:[];return s==='[role="tab"], button, span, div'?tabs:[]}}}
 if(hit)context.document.elementFromPoint=()=>hit
 return value=>vm.runInNewContext(`(${openCommentPanel.toString()})('${id}',${JSON.stringify(value||{})})`,context)
}
function node(label){return {innerText:label,children:[],getBoundingClientRect:()=>({left:700,top:300,width:100,height:40})}}
test('loading open comment panel is detected without clicking its toggle again',()=>{
 let clicks=0;const tab={...node('评论(12)'),click(){clicks++}}
 const r=panelDom({list:true,tabs:[tab]})({activate:true});assert.equal(r.panelVisible,true);assert.equal(clicks,0)
})
test('a visible overlay prevents both native coordinate and script activation',()=>{
 let clicks=0;const tab={...node('评论(12)'),click(){clicks++}}
 const r=panelDom({tabs:[tab],hit:node('overlay')})({activate:true});assert.equal(r.blocked,true);assert.equal(clicks,0);assert.equal(r.point,undefined)
})
for(const label of ['评论(1.2万)','评论（1,203）','评论(0)'])test(`exact comment label supports ${label} without guessing whether comments are empty`,()=>{
 const r=panelDom({tabs:[node(label)]})();assert.equal(r.opened,true);assert.equal(r.ready,undefined)
})
test('two conflicting comment tabs are reported as ambiguous without trying an unrelated icon',()=>{
 const r=panelDom({tabs:[node('评论(12)'),node('评论(3)')]})();assert.equal(r.ambiguous,true);assert.equal(r.point,undefined)
})

function harness({availableAfter=0,panelInitially=false,block=false,challenge=false,wrongPage=false,scriptOnly=false}={}){
 const state={reads:0,clicks:0,scriptClicks:0,panel:panelInitially,focus:0}
 const win={isDestroyed:()=>false,isVisible:()=>true,show(){},focus(){state.focus++},webContents:{focus(){},async executeJavaScript(script){
  if(script.includes('function videoCommentsState')){state.reads++;return wrongPage?{wrongPage:true}:challenge?{challenge:true}:{ready:state.panel,panelVisible:state.panel}}
  if(script.includes('function openCommentPanel')){
   if(block)return{opened:false,reason:'entry_obscured',blocked:true}
   if(state.reads<=availableAfter)return{opened:false,reason:'entry_not_ready'}
   if(script.includes('"activate":true')){state.scriptClicks++;state.panel=true;return{opened:true,activated:true}}
   return {opened:true,point:{x:750,y:320}}
  }
  if(script.includes('advanceCommentViewport'))return{ready:true}
  return null
 }}}
 const s=new CommentCollectionService({storage:createMemoryStorage({friendship:{followed:[]}}),partition:'fixture',log(){}})
 s.ensureWindow=()=>win;s.realClick=async()=>{state.clicks++;if(!scriptOnly)state.panel=true}
 return {s,win,state,run:opts=>s.ensureCommentPanel(win,id,{timeout:100,interval:1,clickInterval:1,...opts})}
}
test('opening waits for a late entry instead of spending the only click before it exists',async()=>{
 const h=harness({availableAfter:2});const r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.clicks,1);assert.ok(h.state.reads>=3)
})
test('the bounded script fallback really receives activate=true when native clicks did not open the panel',async()=>{
 const h=harness({scriptOnly:true});const r=await h.run();assert.equal(r.panelOpened,true);assert.equal(h.state.clicks,1);assert.equal(h.state.scriptClicks,1)
})
test('an already open panel requires zero additional clicks',async()=>{
 const h=harness({panelInitially:true});assert.equal((await h.run()).panelOpened,true);assert.equal(h.state.clicks,0)
})
test('an obscured entry has a specific bounded failure and is never clicked',async()=>{
 // Timing budgets are checked with virtual clocks in 138/139; allow the DOM probe to run under CPU contention.
 const h=harness({block:true}),r=await h.run({timeout:200});assert.equal(r.openFailure,'entry_obscured');assert.equal(h.state.clicks,0)
})
for(const flag of ['challenge','wrongPage'])test(`${flag} prevents all comment actions`,async()=>{
 const h=harness({[flag]:true}),r=await h.run();assert.equal(r[flag],true);assert.equal(h.state.clicks,0);assert.equal(h.state.scriptClicks,0)
})
test('a resumed page ensures comments are open before restoring its scroll position',async()=>{
 const h=harness(),order=[];h.s.ensureCommentPanel=async()=>{order.push('open');return {panelOpened:true}}
 h.win.webContents.executeJavaScript=async script=>{if(script.includes('advanceCommentViewport'))order.push('scroll');return {ready:true}}
 h.s.readSnapshot=async()=>({ready:true,rows:[{commentId:'one',platformUserId:'peer',nickname:'fixture',commentText:'fixture comment'}]})
 const r=await h.s.createTransport().readPage({videoId:id,page:1});assert.equal(r.ok,true);assert.equal(order[0],'open');assert.ok(order.slice(1).every(step=>step==='scroll'))
})
test('resumed-page retries reopen a missing panel instead of only scrolling an absent list',async()=>{
 const h=harness();let opens=0,reads=0;h.s.ensureCommentPanel=async()=>{opens++;return{panelOpened:true}}
 h.s.readSnapshot=async()=>++reads===1?{ready:false}:{ready:true,rows:[{commentId:'one',commentText:'recovered'}]}
 const r=await h.s.createTransport().readPage({videoId:id,page:1});assert.equal(r.ok,true);assert.equal(opens,2)
})
test('the transport preserves a specific opening error for the per-video diagnostic',async()=>{
 const h=harness();h.s.ensureCommentPanel=async()=>({panelOpened:false,openFailure:'entry_not_ready',openClicks:0})
 const r=await h.s.createTransport().readPage({videoId:id,page:0});assert.equal(r.code,'COMMENTS_UNAVAILABLE');assert.match(r.reason,/评论入口/);assert.equal(r.diagnostics.stage,'comment_open')
})
for(const message of ['作品不存在','请先登录','502 Bad Gateway'])test(`previous page text cannot reject the next requested target: ${message}`,()=>{
 const context={URL,location:{href:url,origin:'https://www.douyin.com'},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{title:'旧作品',body:{innerText:message},readyState:'complete',querySelectorAll:()=>[],querySelector:()=>null}}
 const r=vm.runInNewContext(`(${pageReadinessSnapshot.toString()})({url:'https://www.douyin.com/video/7710161602587720822'})`,context)
 assert.equal(r.ready,false);assert.equal(r.matches,false);assert.equal(r.code,undefined)
})
test('real target removal and visible verification still stop page readiness',()=>{
 const context={URL,location:{href:url,origin:'https://www.douyin.com'},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{title:'作品页',body:{innerText:'作品不存在'},readyState:'complete',querySelectorAll:()=>[],querySelector:()=>null}}
 assert.equal(vm.runInNewContext(`(${pageReadinessSnapshot.toString()})({url:'${url}'})`,context).code,'VIDEO_NOT_FOUND')
 context.document.title='验证码中间页'
 assert.equal(vm.runInNewContext(`(${pageReadinessSnapshot.toString()})({url:'https://www.douyin.com/video/7710161602587720822'})`,context).code,'CHALLENGE')
})
