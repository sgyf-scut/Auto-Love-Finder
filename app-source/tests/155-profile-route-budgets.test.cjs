const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { ProfileNavigator } = require('../electron/discovery/profile-navigator.cjs')
const { CommentCollectionService } = require('../electron/discovery/comment-collection-service.cjs')
const { profileSearchQueries, profileUnavailableSnapshot } = require('../electron/discovery/profile-navigation-tools.cjs')

const url = 'https://www.douyin.com/user/fixture_A'
const candidate = { profileUrl: url, platformUserId: 'fixture_A', nickname: '🌈余忆Ly09✨' }
const missing = code => Object.assign(Error(code), { code, preActionFailure: true })
const navigator = () => new ProfileNavigator({ storage: createMemoryStorage() }, { accountId: 'fixture', sourceFor: () => ({ videoId: '123', commentId: '456', videoUrl: 'https://www.douyin.com/video/123' }) })
const page = () => ({ show() {}, isDestroyed: () => false, webContents: { getURL: () => 'about:blank' } })

test('search retries remove decorations while retaining letters, Han characters and distinguishing digits', () => {
  assert.deepEqual(profileSearchQueries(candidate.nickname), [{text:candidate.nickname,mode:'full'}, {text:'余忆Ly09',mode:'plain'}])
  assert.equal(profileSearchQueries('🎮玩家007·甲')[1].text, '玩家007甲')
  assert.deepEqual(profileSearchQueries('余忆Ly09'), [{text:'余忆Ly09',mode:'full'}])
  assert.deepEqual(profileSearchQueries('   '), [])
  assert.equal(profileSearchQueries('✨🌈').length, 1)
  assert.equal(profileSearchQueries('🌈A').length, 1, 'Do not create a broad one-letter retry')
})

for (const text of ['用户不存在', '该用户不存在', '你访问的用户不存在', '你查看的用户不存在']) {
  test('an in-page author click promptly recognizes '+text, async () => {
    const service = new CommentCollectionService({storage:createMemoryStorage()})
    let clicks = 0
    service.realClick = async () => { clicks++ }
    const win = { isDestroyed:()=>false, webContents:{getURL:()=>url, isDestroyed:()=>false,
      on(){}, removeListener(){}, setWindowOpenHandler(){},
      mainFrame:{executeJavaScript:code=>vm.runInNewContext(code,{
        URL, location:new URL(url), document:{title:'资料',readyState:'complete',body:{innerText:text},querySelector:()=>null,querySelectorAll:()=>[]}
      })}} }
    const active=()=>{};active.remainingMs=()=>100
    await assert.rejects(service.clickProfileEntry(win,{x:50,y:50},url,active),{code:'PROFILE_NOT_FOUND'})
    assert.equal(clicks,1)
  })
}

test('the shared unavailable probe preserves explicit restrictions and ignores ordinary discussion', () => {
  const probe = body => vm.runInNewContext('('+profileUnavailableSnapshot.toString()+')()', {document:{body:{innerText:body}}})
  assert.equal(probe('请求过于频繁'), 'ACCESS_RESTRICTED')
  assert.equal(probe('他说用户不存在是什么原因呢'), '')
  assert.equal(probe('资料\n用户不存在！\n返回'), 'PROFILE_NOT_FOUND')
})

test('slow direct and original-comment routes leave usable time for user search', async t => {
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const nav=navigator(), win=page(), entered=[]
  nav.direct=async (_page,_url,alive)=>{entered.push('direct');clock+=alive.remainingMs()+1;alive()}
  nav.viewer={openCommentAuthor:async (_target,alive)=>{entered.push('comment');clock+=alive.remainingMs()+1;alive()}}
  nav.fromSearch=async (_viewer,_target,alive)=>{entered.push('search');alive();assert.ok(alive.remainingMs()>10000);return {page:win}}
  assert.equal((await nav.open(win,candidate,{automated:true,timeoutMs:45000})).method,'search')
  assert.deepEqual(entered,['direct','comment','search'])
  assert.deepEqual(nav.lastAttempts.slice(0,2).map(x=>x.code),['PROFILE_ROUTE_TIMEOUT','PROFILE_ROUTE_TIMEOUT'])
  assert.ok(nav.lastAttempts.every(x=>Number.isFinite(x.elapsedMs)&&x.budgetMs>0))
  assert.ok(clock-100000<45000)
})

test('a total deadline remains binding and forbids later navigation', async t => {
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const nav=navigator(),win=page()
  nav.direct=async (_page,_url,alive)=>{clock+=1100;alive()}
  nav.viewer={openCommentAuthor:()=>assert.fail('No operation after total timeout')}
  nav.fromSearch=()=>assert.fail('No operation after total timeout')
  await assert.rejects(nav.open(win,candidate,{timeoutMs:1000}),error=>error.code==='PROFILE_NAV_TIMEOUT'&&error.profileNavigation[0].elapsedMs===1100)
})

function searchPage() {
  let href='https://www.douyin.com/search/test?type=user'
  const links = [link('fixture_B',10),link('fixture_A',100)]
  function link(id,left){return {href:'https://www.douyin.com/user/'+id,scrollIntoView(){},getBoundingClientRect:()=>({left,top:20,width:40,height:20}),contains:()=>false}}
  const win={webContents:{getURL:()=>href,mainFrame:{executeJavaScript:code=>vm.runInNewContext(code,{
    URL,location:new URL(href),document:{title:'搜索',body:{innerText:'同名用户'},querySelectorAll:selector=>selector.includes('/user/')?links:[],elementFromPoint:x=>x>100?links[1]:links[0]}
  })}}}
  return {win,setHref:value=>{href=value},links}
}

test('full decorated search can time out and plain-name retry selects only the exact platform ID', async t => {
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const nav=navigator(),p=searchPage(),queries=[],attempts=[];let clicks=0
  const evaluate=p.win.webContents.mainFrame.executeJavaScript
  p.win.webContents.mainFrame.executeJavaScript=code=>{if(queries.length===1){clock+=9001;return {point:null}}return evaluate(code)}
  const viewer={ensureWindow:()=>p.win,navigate:async (_win,href,options)=>{assert.ok(options.timeoutMs<=18000);options.assertActive();queries.push(decodeURIComponent(new URL(href).pathname.slice('/search/'.length)));p.setHref(href)},
    clickProfileEntry:async (win,point,target,active)=>{active();assert.equal(win,p.win);assert.equal(point.x,120);assert.equal(target,url);clicks++;return {page:win}}}
  const result=await nav.fromSearch(viewer,{url,name:candidate.nickname},()=>{},{onAttempt:row=>attempts.push(row)})
  assert.equal(result.page,p.win);assert.deepEqual(queries,[candidate.nickname,'余忆Ly09']);assert.equal(clicks,1)
  assert.equal(attempts[0].code,'SEARCH_QUERY_TIMEOUT');assert.equal(attempts[1].status,'verified')
  assert.ok(attempts[0].elapsedMs>=9000)
})

test('two searches showing only another same-name account never click it',async t=>{
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const nav=navigator(),p=searchPage();p.links.pop();let searches=0
  const evaluate=p.win.webContents.mainFrame.executeJavaScript
  p.win.webContents.mainFrame.executeJavaScript=code=>{const result=evaluate(code);clock+=10000;return result}
  const viewer={ensureWindow:()=>p.win,navigate:async(_win,href)=>{searches++;p.setHref(href)},clickProfileEntry:()=>assert.fail('Never click another account')}
  await assert.rejects(nav.fromSearch(viewer,{url,name:candidate.nickname},()=>{}),{code:'SEARCH_ENTRY_UNAVAILABLE'})
  assert.equal(searches,2)
})

for (const code of ['CHALLENGE','LOGIN_REQUIRED','ACCESS_RESTRICTED','ACCOUNT_ID_MISMATCH']) {
  test('search stops on '+code+' instead of trying a plain nickname',async()=>{
    const nav=navigator(),win=page();let calls=0
    const viewer={ensureWindow:()=>win,navigate:async()=>{calls++;throw missing(code)},clickProfileEntry:()=>assert.fail('No click after a gate')}
    await assert.rejects(nav.fromSearch(viewer,{url,name:candidate.nickname},()=>{}),{code})
    assert.equal(calls,1)
  })
}

test('account cancellation during search forbids a retry or click',async()=>{
  const nav=navigator(),win=page();let cancelled=false,calls=0
  const active=()=>{if(cancelled)throw missing('READ_CANCELLED')}
  const viewer={ensureWindow:()=>win,navigate:async()=>{calls++;cancelled=true;active()},clickProfileEntry:()=>assert.fail('Cancelled account must not click')}
  await assert.rejects(nav.fromSearch(viewer,{url,name:candidate.nickname},active),{code:'READ_CANCELLED'})
  assert.equal(calls,1)
})

test('the original-comment route propagates its remaining time through navigation and comment opening',async t=>{
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const service=new CommentCollectionService({storage:createMemoryStorage()}),win=page(),observed=[]
  service.ensureWindow=()=>win;service.presentWindow=()=>{};service.exclusive=fn=>fn()
  const active=()=>{if(clock>=101000)throw missing('PROFILE_ROUTE_TIMEOUT')};active.remainingMs=()=>101000-clock
  service.navigate=async(_win,_url,options)=>{observed.push(options.timeoutMs);clock+=100}
  service.ensureCommentPanel=async(_win,_video,options)=>{assert.equal(options.deadlineAt,101000);await options.assertActive();return {panelOpened:true}}
  win.webContents.mainFrame={executeJavaScript:code=>code.startsWith('/访问过于频繁')?false:{authorPoint:{x:1,y:1}}}
  service.clickProfileEntry=async(_win,_point,_url,alive)=>{assert.equal(alive,active);return {page:win}}
  const out=await service.openCommentAuthor({videoId:'123',videoUrl:'https://www.douyin.com/video/123',commentId:'456',platformUserId:'fixture_A',profileUrl:url},active)
  assert.equal(out.page,win);assert.deepEqual(observed,[1000])
})

test('a navigation cannot continue its old thirty-second wait after the route expires',async t=>{
  let clock=100000;t.mock.method(Date,'now',()=>clock)
  const service=new CommentCollectionService({storage:createMemoryStorage()}),win=page()
  const active=()=>{if(clock>=100200)throw missing('PROFILE_ROUTE_TIMEOUT')};active.remainingMs=()=>100200-clock
  win.loadURL=async()=>{};win.webContents.mainFrame={executeJavaScript:()=>{clock+=300;return false}}
  await assert.rejects(service.navigate(win,url,{profileEntry:true,assertActive:active,timeoutMs:200}),{code:'PROFILE_ROUTE_TIMEOUT'})
  assert.ok(clock<101000)
})

test('batch profile verification supplies the multi-route budget and preserves trace details',async()=>{
  const {DiscoveryEngine}=require('../electron/discovery/discovery-engine.cjs')
  const engine=new DiscoveryEngine({storage:createMemoryStorage(),profileNavigator:{lastAttempts:[],open:async(_win,_candidate,options)=>{
    assert.equal(options.timeoutMs,45000)
    throw Object.assign(missing('PAGE_NOT_READY'),{profileNavigation:[{method:'原评论',code:'PROFILE_ROUTE_TIMEOUT',elapsedMs:19800,budgetMs:19800}]})
  }}},{accountId:'fixture'})
  engine.ensureWindow=()=>page();engine.checkBatchVerification=async()=>({ok:true})
  const out=await engine.readBatchGender(candidate)
  assert.equal(out.code,'PROFILE_UNAVAILABLE');assert.equal(out.diagnostics.profileNavigation[0].elapsedMs,19800)
})

test('profile diagnostics distinguish unverified pages from nonexistent users and safely show timed search queries',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8')
  const fn=source.slice(source.indexOf('function batchProfileReadView('),source.indexOf('function batchIntentOptions('))
  const html=vm.runInNewContext(fn+';batchProfileReadView({genderReadResults:[{code:"PROFILE_UNAVAILABLE",diagnostics:{profileNavigation:[{method:"搜索",query:"<b>人名</b>",status:"failed",reason:"超时",elapsedMs:9000}]}}]})',{
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  })
  assert.match(html,/主页未能核验/);assert.match(html,/9秒/);assert.match(html,/&lt;b&gt;人名/)
  assert.doesNotMatch(html,/页面提示用户不存在/)
})
