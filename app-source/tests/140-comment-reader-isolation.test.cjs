const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {createMemoryStorage}=require('./setup.cjs')
const electron=require('electron');electron.session={fromPartition:()=>({cookies:{get:async()=>[{name:'sessionid'}]}})}
const {navigateReadable,pageReadinessSnapshot}=require('../electron/discovery/page-readiness.cjs')
const {videoCommentsState,openCommentPanel}=require('../electron/discovery/comment-snapshot.cjs')
const {CommentCollectionService}=require('../electron/discovery/comment-collection-service.cjs')
const {BatchRunner}=require('../electron/discovery/batch-runner.cjs')
const a='7711224680274914762',b='7711219897677687270',url=id=>'https://www.douyin.com/video/'+id
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

test('the next target drains the previous pending navigation before loadURL',async()=>{
 const old=deferred(),order=[];let calls=0
 const win={loadURL(u){order.push('load:'+u);return ++calls===1?old.promise:Promise.resolve()},webContents:{stop(){order.push('stop-old');old.reject(Error('ERR_ABORTED previous'))}}}
 assert.equal((await navigateReadable(win,url(a),{read:async()=>({ready:true,href:url(a)})})).ok,true)
 assert.equal((await navigateReadable(win,url(b),{read:async()=>({ready:true,href:url(b)})})).ok,true)
 assert.deepEqual(order,['load:'+url(a),'stop-old','load:'+url(b)])
})
test('a late ready result for A cannot finish or stop navigation B',async()=>{
 const old=deferred();let stops=0
 const win={loadURL:async()=>{},webContents:{stop(){stops++}}}
 const first=navigateReadable(win,url(a),{read:()=>old.promise});await new Promise(setImmediate)
 const second=await navigateReadable(win,url(b),{read:async()=>({ready:true,href:url(b)})})
 old.resolve({ready:true,href:url(a)});assert.equal((await first).code,'READ_CANCELLED');assert.equal(second.ok,true);assert.equal(stops,0)
})
test('an aborted previous-work URL is retained as unrelated evidence, never blamed on the new target',async()=>{
 const win={loadURL:async()=>{throw Error('ERR_ABORTED loading '+url(a))},webContents:{stop(){}}}
 const r=await navigateReadable(win,url(b),{timeout:8,interval:1,read:async()=>({ready:false,href:url(b)})})
 assert.equal(r.code,'TIMEOUT');assert.doesNotMatch(r.reason,new RegExp(a));assert.match(r.ignoredNavigationError,new RegExp(a))
})
test('an alleged ready result from another target is not accepted',async()=>{
 const r=await navigateReadable({loadURL:async()=>{},webContents:{stop(){}}},url(b),{timeout:8,interval:1,read:async()=>({ready:true,href:url(a)})})
 assert.equal(r.code,'TIMEOUT')
})
function dom(href,over={}){return {location:{origin:'https://www.douyin.com',href},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{title:'作品',readyState:'complete',body:{innerText:''},querySelectorAll:()=>[],...over}}}
function run(fn,args,context){return vm.runInNewContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context)}
test('a page without a work identity cannot supply comment state for a previous target',()=>{assert.equal(run(videoCommentsState,[a],dom('https://www.douyin.com/')).wrongPage,true)})
test('verification without a work ID still takes precedence and requests human handling',()=>{assert.equal(run(videoCommentsState,[a],dom('https://www.douyin.com/verify',{title:'验证码中间页'})).challenge,true)})
test('same-work video to note redirect keeps valid comment identity',()=>{const r=run(videoCommentsState,[a],dom(url(a).replace('/video/','/note/')));assert.equal(r.wrongPage,undefined);assert.equal(r.videoId,a)})
test('entry inspection never pauses playback or changes the media loading state',()=>{
 let pauses=0;const video={pause(){pauses++},getBoundingClientRect:()=>({width:100,height:100})}
 run(openCommentPanel,[a,{activate:false}],dom(url(a),{querySelectorAll:s=>s==='video'?[video]:[]}));assert.equal(pauses,0)
})
test('a uniquely labelled accessible comment button can be used without guessing unrelated text',()=>{
 const node={getAttribute:k=>k==='aria-label'?'查看评论':null,getBoundingClientRect:()=>({left:20,top:30,width:100,height:50})}
 const r=run(openCommentPanel,[a],dom(url(a),{querySelectorAll:s=>s.includes('button[aria-label]')?[node]:[]}));assert.equal(r.source,'accessible_comment_button');assert.equal(r.point.x,70)
})
function serviceFixture(){
 const service=new CommentCollectionService({storage:createMemoryStorage(),partition:'fixture'});let current=a,closed=false
 const win={isDestroyed:()=>closed,isVisible:()=>true,show(){},destroy(){closed=true},webContents:{getURL:()=>url(current),async executeJavaScript(code){if(code.includes('function videoCommentsState'))return {ready:true};if(code.startsWith('String(document.title'))return 'fixture title';return null}}}
 service.ensureWindow=()=>win;service.waitForContentUrl=async()=>url(current)
 service.navigate=async(w,u)=>{current=u.match(/\d+/)[0]};service.captureReadFailure=async(w,id,result)=>result
 return {service,win,setCurrent:id=>current=id,isClosed:()=>closed}
}
test('overlapping transports are serialized and old results are discarded',async()=>{
 const f=serviceFixture(),gate=deferred(),entered=deferred(),order=[];let active=0,peak=0
 f.service.navigate=async(w,u)=>{active++;peak=Math.max(peak,active);order.push(u);if(u===url(a)){entered.resolve();await gate.promise}f.setCurrent(u.match(/\d+/)[0]);active--}
 const old=f.service.createTransport(),next=f.service.createTransport();const first=old.prepare({videoId:a});await entered.promise
 const second=next.prepare({videoId:b});gate.resolve()
 assert.equal((await first).code,'READ_CANCELLED');assert.equal((await second).videoId,b);assert.equal(peak,1);assert.deepEqual(order,[url(a),url(b)])
 old.cancel();assert.equal(f.isClosed(),false);next.cancel();assert.equal(f.isClosed(),true)
})
test('a new prepare on the same transport invalidates the immutable executing request',async()=>{
 const f=serviceFixture(),gate=deferred(),entered=deferred();let priorCurrent=true
 f.service.navigate=async(w,u,{isCurrent})=>{if(u===url(a)){entered.resolve();await gate.promise;priorCurrent=isCurrent()}f.setCurrent(u.match(/\d+/)[0])}
 const t=f.service.createTransport(),first=t.prepare({videoId:a});await entered.promise;const second=t.prepare({videoId:b});gate.resolve()
 assert.equal((await first).code,'READ_CANCELLED');assert.equal((await second).videoId,b);assert.equal(priorCurrent,false)
})
test('readPage cannot reuse another video preparation',async()=>{
 const f=serviceFixture(),t=f.service.createTransport();assert.equal((await t.prepare({videoId:a})).ok,true);assert.equal((await t.readPage({videoId:b})).code,'READ_CANCELLED')
})
test('temporary navigation errors have one retry, while verification is never retried',async()=>{
 const f=serviceFixture();let calls=0
 f.service.navigate=async()=>{calls++;if(calls===1)throw Object.assign(Error('network temporarily unavailable'),{code:'NETWORK_ERROR'});f.setCurrent(a)}
 assert.equal((await f.service.createTransport().prepare({videoId:a})).ok,true);assert.equal(calls,2)
 calls=0;f.service.navigate=async()=>{calls++;throw Object.assign(Error('Please verify'),{code:'CHALLENGE'})}
 assert.equal((await f.service.createTransport().prepare({videoId:a})).code,'CHALLENGE');assert.equal(calls,1)
})
test('failure evidence stores a bounded local screenshot and record with query strings removed',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reader-diagnostics-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})});electron.app={getPath:()=>dir}
 const f=serviceFixture();f.win.webContents.getURL=()=>url(a)+'?private=do-not-persist';f.win.webContents.capturePage=async()=>({isEmpty:()=>false,toPNG:()=>Buffer.from('fixture png')})
 const r=await CommentCollectionService.prototype.captureReadFailure.call(f.service,f.win,a,{ok:false,code:'COMMENTS_UNAVAILABLE',diagnostics:{stage:'comment_open'}},{requestId:1})
 assert.ok(fs.existsSync(r.diagnostics.screenshotPath));assert.ok(fs.existsSync(r.diagnostics.recordPath));assert.equal(r.diagnostics.currentPage,url(a));assert.doesNotMatch(fs.readFileSync(r.diagnostics.recordPath,'utf8'),/private=do-not-persist/)
})
test('failure screenshot errors retain the original failure classification',async()=>{
 const f=serviceFixture();f.win.webContents.capturePage=async()=>{throw Error('Screenshot unavailable')};const r=await CommentCollectionService.prototype.captureReadFailure.call(f.service,f.win,a,{ok:false,code:'TIMEOUT'},{requestId:2});assert.equal(r.code,'TIMEOUT');assert.match(r.diagnostics.captureError,/Screenshot unavailable/)
})
test('confirmed closed comments and deleted works are skipped instead of counted as read failures',()=>{
 const changes=[],bumps=[];const subject={patchQueueItem:(id,patch)=>changes.push(patch),bumpProgress:p=>bumps.push(p),bumpDiagnostics(){}}
 for(const code of ['COMMENTS_CLOSED','VIDEO_NOT_FOUND'])BatchRunner.prototype.markCollectionFailed.call(subject,{videoId:a},{code,reason:'confirmed',judgeable:false},{})
 assert.ok(changes.every(p=>p.status==='skipped'));assert.ok(bumps.every(p=>p.videosSkipped===1&&!p.videosFailed))
})

test('a visible comment control establishes a readable short page without an arbitrary text-length requirement',()=>{
 const context=dom(url(a),{body:{innerText:'短标题'},querySelector:()=>({})});context.URL=URL
 assert.equal(run(pageReadinessSnapshot,[{url:url(a)}],context).ready,true)
})
test('a page switched just before returning rows cannot provide accepted comments',async()=>{
 const f=serviceFixture(),t=f.service.createTransport();await t.prepare({videoId:a})
 f.service.ensureCommentPanel=async()=>{f.setCurrent(b);return {panelOpened:true}}
 f.service.readSnapshot=async()=>({ready:true,rows:[{commentText:'late row'}]})
 const result=await t.readPage({videoId:a});assert.equal(result.code,'READ_TARGET_MISMATCH');assert.equal(result.rows,undefined)
})
test('local failure evidence retains at most twenty scene pairs',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reader-retention-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})});electron.app={getPath:()=>dir}
 const f=serviceFixture();f.win.webContents.capturePage=async()=>({isEmpty:()=>false,toPNG:()=>Buffer.from('fixture')})
 for(let requestId=1;requestId<=22;requestId++)await CommentCollectionService.prototype.captureReadFailure.call(f.service,f.win,a,{ok:false,code:'TIMEOUT'},{requestId})
 const files=fs.readdirSync(path.join(dir,'diagnostics/comment-reading'));assert.equal(files.filter(n=>n.endsWith('.json')).length,20);assert.equal(files.filter(n=>n.endsWith('.png')).length,20)
})

test('starting a new work clears the previous work’s failure evidence pointer',async()=>{
 const f=serviceFixture(),t=f.service.createTransport();await t.prepare({videoId:a})
 f.service.ensureCommentPanel=async()=>({panelOpened:false,openFailure:'entry_not_ready'})
 f.service.captureReadFailure=async(w,id,result)=>({...result,diagnostics:{expectedVideoId:id}})
 await t.readPage({videoId:a});assert.equal(t.diagnostics().expectedVideoId,a)
 await t.prepare({videoId:b});assert.equal(t.diagnostics(),null)
})
