const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {createMemoryStorage}=require('./setup.cjs')
const {webCompatibleUserAgent,installDouyinSessionPolicy}=require('../electron/navigation-policy.cjs')
const {startProfileTrace}=require('../electron/discovery/profile-trace.cjs')
const {ProfileNavigator}=require('../electron/discovery/profile-navigator.cjs')
const {DiscoveryEngine}=require('../electron/discovery/discovery-engine.cjs')
const identity={profileUrl:'https://www.douyin.com/user/session_target',platformUserId:'session_target'}
const api='https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=session_target'
const native='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DouyinAssistant/1.1.0 Chrome/138.0.7204.185 Electron/37.2.6 Safari/537.36'

test('web compatibility removes application products and keeps the actual Chromium version',()=>{
 const value=webCompatibleUserAgent(native)
 assert.match(value,/Chrome\/138\.0\.7204\.185/);assert.match(value,/Safari\/537\.36/)
 assert.doesNotMatch(value,/Electron|DouyinAssistant|Edg\//)
 assert.equal(webCompatibleUserAgent(value),value)
})
test('existing standard browser identifiers are not rewritten',()=>{
 const edge='Mozilla/5.0 Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0'
 assert.equal(webCompatibleUserAgent(edge),edge);assert.equal(webCompatibleUserAgent(''), '')
})
test('account session compatibility is installed once and preserves external-app permission denial',()=>{
 const writes=[];let check,request
 const session={getUserAgent:()=>native,setUserAgent:value=>writes.push(value),setPermissionCheckHandler:fn=>{check=fn},setPermissionRequestHandler:fn=>{request=fn}}
 installDouyinSessionPolicy(session);installDouyinSessionPolicy(session)
 assert.equal(writes.length,1);assert.match(writes[0],/Chrome\/138/)
 assert.equal(check(null,'openExternal'),false);let allowed;request(null,'openExternal',value=>{allowed=value});assert.equal(allowed,false)
 assert.equal(check(null,'notifications'),true)
})

function fixture({body='',code='PROFILE_NOT_FOUND',mime='application/json',other=false,bodyError=false}={}){
 let attached=false,detaches=0,href='about:blank'
 const debuggerApi=new EventEmitter()
 debuggerApi.attach=()=>{attached=true};debuggerApi.isAttached=()=>attached
 debuggerApi.detach=()=>{attached=false;detaches++}
 debuggerApi.sendCommand=async(method)=>{
  if(method==='Network.getResponseBody'){if(bodyError)throw Error('No resource');return {body,base64Encoded:false}}
  return {}
 }
 const event=(name,payload)=>debuggerApi.emit('message',{},'Network.'+name,payload)
 const emit=()=>{
  const url=other?api.replace('session_target','someone_else'):api
  event('requestWillBeSent',{requestId:'profile',request:{url,method:'GET'}})
  event('responseReceived',{requestId:'profile',response:{url,status:200,mimeType:mime}})
  event('loadingFinished',{requestId:'profile',encodedDataLength:100})
 }
 const win={loadURL:async value=>{href=value;emit()},webContents:{debugger:debuggerApi,getURL:()=>href,mainFrame:{executeJavaScript:async()=>({code})}}}
 return {win,emit,get detaches(){return detaches}}
}
test('an empty successful HTTP response is recorded distinctly without storing body content',async()=>{
 const h=fixture(),trace=await startProfileTrace(h.win,identity);h.emit()
 const result=await trace.stop();assert.equal(result.requests[0].responseBodyState,'empty')
 assert.equal(result.requests[0].businessStatus,undefined);assert.doesNotMatch(JSON.stringify(result),/requestId|sec_user_id=/)
})
test('text/plain profile responses may carry valid JSON business results',async()=>{
 const h=fixture({mime:'text/plain',body:JSON.stringify({status_code:0,user:{secret:'do-not-save'}})}),trace=await startProfileTrace(h.win,identity);h.emit()
 const result=await trace.stop();assert.equal(result.requests[0].businessStatus,0);assert.equal(result.requests[0].responseBodyState,'present')
 assert.doesNotMatch(JSON.stringify(result),/do-not-save|secret/)
})
test('another account response cannot establish an empty response for this target',async()=>{
 const h=fixture({other:true}),trace=await startProfileTrace(h.win,identity);h.emit()
 assert.equal((await trace.stop()).requests.length,0)
})
test('an unavailable diagnostic body is not reported as an actually empty response',async()=>{
 const h=fixture({bodyError:true}),trace=await startProfileTrace(h.win,identity);h.emit()
 assert.equal((await trace.stop()).requests[0].responseBodyState,undefined)
})
test('direct navigation observes the real request before deciding that a profile is nonexistent',async()=>{
 const h=fixture(),nav=new ProfileNavigator({storage:createMemoryStorage()},{accountId:'fixture'})
 await assert.rejects(nav.direct(h.win,identity.profileUrl,()=>{}),error=>{
  assert.equal(error.code,'PROFILE_RESPONSE_EMPTY');assert.equal(error.diagnostics.network.requests[0].responseBodyState,'empty')
  assert.match(error.message,/空正文/);assert.equal(error.sendAttempted,false);return true
 })
 assert.equal(h.detaches,1)
})
for(const code of ['CHALLENGE','LOGIN_REQUIRED','ACCESS_RESTRICTED'])test('an empty response never masks the explicit '+code+' gate',async()=>{
 const h=fixture({code}),nav=new ProfileNavigator({storage:createMemoryStorage()},{accountId:'fixture'})
 await assert.rejects(nav.direct(h.win,identity.profileUrl,()=>{}),{code})
})
test('a nonempty response keeps the existing missing-profile outcome',async()=>{
 const h=fixture({body:'{"status_code":4}'}),nav=new ProfileNavigator({storage:createMemoryStorage()},{accountId:'fixture'})
 await assert.rejects(nav.direct(h.win,identity.profileUrl,()=>{}),{code:'PROFILE_NOT_FOUND'})
})
test('an observed empty response does not repeat the same session through more navigation routes',async()=>{
 const h=fixture(),nav=new ProfileNavigator({storage:createMemoryStorage()},{accountId:'fixture'})
 nav.viewer={openCommentAuthor:()=>assert.fail('Do not repeat a known empty response via another entrance')}
 nav.fromSearch=()=>assert.fail('Do not retry nicknames for an empty profile response')
 await assert.rejects(nav.open(h.win,identity),{code:'PROFILE_RESPONSE_EMPTY'})
 assert.equal(nav.lastAttempts[0].code,'PROFILE_RESPONSE_EMPTY')
})
test('batch filtering retains the pending candidate and empty-response evidence',async()=>{
 const engine=new DiscoveryEngine({storage:createMemoryStorage(),profileNavigator:{open:async()=>{throw Object.assign(Error('资料接口空正文'),{code:'PROFILE_RESPONSE_EMPTY',diagnostics:{network:{requests:[{responseBodyState:'empty'}]}}})}}},{accountId:'fixture'})
 engine.ensureWindow=()=>({});engine.checkBatchVerification=async()=>({ok:true})
 const result=await engine.readBatchGender(identity)
 assert.equal(result.code,'PROFILE_UNAVAILABLE');assert.equal(result.retryable,false);assert.equal(result.publicSignals,undefined)
 assert.equal(result.diagnostics.network.requests[0].responseBodyState,'empty')
})
