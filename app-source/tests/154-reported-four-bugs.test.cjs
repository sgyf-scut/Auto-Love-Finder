const {test} = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path')
require('./setup.cjs')
const {verificationSnapshot} = require('../electron/discovery/verification-dom.cjs')
const {ProfileNavigator} = require('../electron/discovery/profile-navigator.cjs')
const {VideoSources, visibleVideoSnapshot, keywordSearchUrl, normalizeVideoItem} = require('../electron/discovery/video-sources.cjs')
const {createMemoryStorage} = require('./setup.cjs')
const url = 'https://www.douyin.com/user/fixture', videoId = '7300000000000000001'
function frame({src='https://rmc.bytedance.com/verifycenter/puzzle',style={},rect={},parentElement=null}={}) {
 return {tagName:'IFRAME',src,style,parentElement,getAttribute:k=>k==='src'?src:null,getBoundingClientRect:()=>({width:300,height:200,top:20,left:20,right:320,bottom:220,...rect})}
}
function probe(nodes,{body='',title=''}={}) {
 return vm.runInNewContext('('+verificationSnapshot.toString()+')()', {document:{title,body:{innerText:body},querySelectorAll:()=>nodes},getComputedStyle:n=>n.style||{},innerWidth:1200,innerHeight:800})
}
test('a hidden or passive nocaptcha frame is not a human challenge',()=>{
 assert.equal(probe([frame({style:{visibility:'hidden'}})]).challenge,false)
 assert.equal(probe([frame({rect:{width:0,height:0}})]).challenge,false)
 assert.equal(probe([frame({src:'https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/1.0/index.html'})],{body:'普通评论提到拖动滑块'}).challenge,false)
})
test('ancestor visibility and off-screen challenges are respected',()=>{
 assert.equal(probe([frame({parentElement:{style:{display:'none'}}})]).challenge,false)
 assert.equal(probe([frame({rect:{top:900,bottom:1100}})]).challenge,false)
})
test('a visible puzzle or dedicated verification page still stops work',()=>{
 assert.equal(probe([frame()]).challenge,true)
 assert.equal(probe([],{title:'验证码中间页'}).challenge,true)
})
test('profile navigation ignores a background frame and records each attempted route',async()=>{
 const navigator=new ProfileNavigator({storage:createMemoryStorage()},{accountId:'a'})
 const hidden=frame({style:{display:'none'},src:'https://rmc.bytedance.com/verifycenter/nocaptcha'})
 const page={show(){},webContents:{getURL:()=>url,mainFrame:{executeJavaScript:script=>vm.runInNewContext(script,{URL,location:new URL(url),document:{title:'资料',body:{innerText:'用户不存在'},querySelector:selector=>selector.includes('iframe')?hidden:null,querySelectorAll:()=>[hidden]}})}}}
 assert.equal((await navigator.inspect(page,url)).code,'PROFILE_NOT_FOUND')
 navigator.direct=async()=>{throw Object.assign(Error('missing'),{code:'PROFILE_NOT_FOUND'})}
 navigator.viewer={openCommentAuthor:async()=>{throw Object.assign(Error('no source'),{code:'COMMENT_ENTRY_UNAVAILABLE'})}}
 navigator.sourceFor=()=>({videoId:'123',commentId:'456'})
 navigator.fromSearch=async()=>({page})
 assert.equal((await navigator.open({webContents:{getURL:()=> 'about:blank'}},{url,name:'测试'})).method,'search')
 assert.deepEqual(navigator.lastAttempts.map(x=>x.method),['直开','原评论','search'])
})
test('keyword collection waits for rendered results before using the legacy interface',async()=>{
 const source=new VideoSources({})
 source.preparePage=async()=>{};let count=0
 source.evalInPage=async fn=>{assert.equal(fn,visibleVideoSnapshot);return ++count===1?{ok:false,items:[]}:{ok:true,items:[{videoId,title:'搭子',videoUrl:'https://www.douyin.com/note/'+videoId}]}}
 const wait=source.waitVisibleVideos.bind(source);source.waitVisibleVideos=url=>wait(url,{timeout:100,interval:1})
 source.requestVideos=()=>assert.fail('Rendered results should be enough')
 const out=await source.collectByKeyword('搭子')
 assert.equal(out.ok,true);assert.equal(count,2);assert.equal(out.videos[0].videoUrl,'https://www.douyin.com/note/'+videoId)
})
test('keyword rendering retries a transient script failure without treating the source as empty',async()=>{
 const source=new VideoSources({});let calls=0
 source.evalInPage=async()=>{if(++calls===1)throw Error('context replaced');return {ok:true,items:[{videoId}]}}
 const out=await source.waitVisibleVideos(keywordSearchUrl('搭子'),{timeout:100,interval:1})
 assert.equal(out.items.length,1);assert.equal(calls,2)
})
test('keyword verification stops before API fallback and does not become an empty success',async()=>{
 const source=new VideoSources({douyin:{},ensureWindow:()=>({show(){}})})
 source.preparePage=async()=>{};source.waitVisibleVideos=async()=>({ok:false,kind:'LOGIN_REQUIRED',items:[]})
 source.requestVideos=()=>assert.fail('Must stop on login gate')
 const out=await source.collectByKeyword('搭子');assert.equal(out.ok,false);assert.equal(out.kind,'LOGIN_REQUIRED')
})
test('visible search cards accept exact modal links but reject off-platform links',()=>{
 const query=keywordSearchUrl('搭子'), link=href=>({href,innerText:'搭子视频',getBoundingClientRect:()=>({width:200,height:100,top:20,bottom:120}),getAttribute:()=>'',querySelector:()=>null})
 const links=[link(query+'&modal_id='+videoId),link('https://evil.invalid/video/'+videoId)]
 const out=vm.runInNewContext('('+visibleVideoSnapshot.toString()+')({url:'+JSON.stringify(query)+'})',{URL,location:new URL(query),innerHeight:800,getComputedStyle:()=>({}),document:{title:'搜索',body:{innerText:'搭子视频'},querySelectorAll:selector=>selector.startsWith('a[')?links:[]}})
 assert.equal(out.items.length,1);assert.equal(out.items[0].videoId,videoId)
})

const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve}}
function ui() {
 let accountChanged,event;const intervals=[]
 const api={onDouyinEvent:fn=>{event=fn},getInfo:async()=>({}),accounts:{onChanged:fn=>{accountChanged=fn},list:async()=>({active:'b',accounts:[]}),switch:async()=>({state:{contacts:[{name:'B'}]}})},automation:{getState:async()=>({contacts:[{name:'B'}]})},douyin:{getStatus:async()=>({connected:false})}}
 const screen={innerHTML:'',outerHTML:''}
 const document={addEventListener(){},getElementById:()=>screen,querySelector:()=>null}
 const context=vm.createContext({window:{desktopApp:api},document,setInterval:fn=>{intervals.push(fn)},setTimeout(){},clearTimeout(){}})
 const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8').replace(/loadAll\(\)\s*$/,'')
 vm.runInContext(source+'\nrender=()=>{};queueDynamic=()=>{};batchPoll=()=>{};showNotice=()=>{};loadDiscoveryMode=()=>{};loadBatch=()=>{};S.section="chat";S.accounts.active="a";S.data={contacts:[{name:"A"}],pendingDrafts:[{text:"old"}]};S.selected="A";globalThis.subject={S,ACTIONS,beginAccountUiTransition,loadAll};',context)
 return {...context.subject,api,screen,changed:()=>accountChanged(),event:e=>event(e),intervals}
}
test('account notification immediately removes old chat selection, history and drafts while loading',async()=>{
 const f=ui(), wait=deferred();f.api.accounts.list=()=>wait.promise
 const run=f.changed();assert.equal(f.S.data.contacts.length,0);assert.equal(f.S.data.pendingDrafts.length,0);assert.equal(f.S.selected,'')
 f.event({accountId:'a',type:'contacts',payload:{contacts:[{name:'late A'}]}});assert.equal(f.S.data.contacts.length,0)
 wait.resolve({active:'b',accounts:[]});await run;assert.equal(f.S.data.contacts[0].name,'B')
})
test('a slower previous account response cannot overwrite the latest account',{timeout:4000},async()=>{
 const f=ui(), b=deferred(), c=deferred();let calls=0
 f.api.automation.getState=()=>++calls===1?b.promise:c.promise
 const first=f.changed();await new Promise(setImmediate);assert.equal(calls,1)
 f.api.accounts.list=async()=>({active:'c',accounts:[]});const second=f.changed();await new Promise(setImmediate);assert.equal(calls,2)
 c.resolve({contacts:[{name:'C'}]});await second;b.resolve({contacts:[{name:'B'}]});await first
 assert.equal(f.S.accounts.active,'c');assert.equal(f.S.data.contacts[0].name,'C')
})
test('late login status and startup results are discarded after a switch begins',async()=>{
 const f=ui(), status=deferred();f.api.douyin.getStatus=()=>status.promise
 const poll=f.intervals.find(fn=>fn.toString().includes('getStatus'));const pending=poll()
 f.beginAccountUiTransition('b');status.resolve({connected:true});await pending;assert.equal(f.S.status.connected,false)
 const state=deferred();f.api.automation.getState=()=>state.promise;const load=f.loadAll();f.beginAccountUiTransition('c');state.resolve({contacts:[{name:'old'}]});await load
 assert.equal(f.S.data.contacts.length,0)
})

test('the account selector clears old data before the switch request finishes',async()=>{
 const f=ui(), response=deferred();f.api.accounts.switch=()=>response.promise
 const pending=f.ACTIONS['account-switch']({id:'b'})
 assert.equal(f.S.data.contacts.length,0);assert.equal(f.S.data.pendingDrafts.length,0)
 const changed=f.changed();await changed
 response.resolve({state:{contacts:[{name:'stale switch response'}]}});await pending
 assert.equal(f.S.accounts.active,'b');assert.equal(f.S.data.contacts[0].name,'B')
})

test('an old startup failure cannot replace the newly selected account screen',async()=>{
 const f=ui();let reject
 f.api.automation.getState=()=>new Promise((resolve,failed)=>{reject=failed})
 const pending=f.loadAll();f.beginAccountUiTransition('c')
 // The current screen must not receive an initialization-error write from an old request.
 f.screen.innerHTML='current account screen'
 f.S.data.contacts=[{name:'C'}]
 reject(Error('old account failed'));await pending
 assert.equal(f.S.accounts.active,'c');assert.equal(f.S.data.contacts[0].name,'C')
 assert.equal(f.screen.innerHTML,'current account screen')
})
