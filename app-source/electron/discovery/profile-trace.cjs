// Passive, window-scoped observation of requests the page itself makes. Never
// intercept, replay, change headers, or retain cookies, signatures, or payloads.
const bounded = (promise, ms) => { let timer; return Promise.race([Promise.resolve(promise), new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('trace timeout')),ms)})]).finally(()=>clearTimeout(timer)) }
function relevantRequest(value, expectedId) {
  try {
    const u=new URL(value)
    if(u.origin!=='https://www.douyin.com')return null
    const isDocument=u.pathname===`/user/${expectedId}`
    const isProfile=/\/user\/(?:profile|detail)(?:\/|$)/.test(u.pathname)
    const subject=u.searchParams.get('sec_user_id')||u.searchParams.get('sec_uid')||u.searchParams.get('secUid')
    if(!isDocument&&!(isProfile&&subject===expectedId))return null
    return {endpoint:u.origin+u.pathname,kind:isDocument?'document':'profile',platformUserId:expectedId}
  }catch{return null}
}
const safeMessage=value=>String(value||'').replace(/https?:\/\/\S+/g,'[url]').replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|(?:token|cookie|authorization|signature|msToken|a_bogus)\s*[:=]\s*[^\s,;]+)/gi,'[omitted]').slice(0,160)
async function startProfileTrace(win, identity, {now=Date.now}={}) {
 const started=now(),requests=[],inFlight=new Map(),pending=new Set(),debug=win.webContents?.debugger
 let active=true,owned=false,availability='unavailable',unavailableReason='',initializing=Promise.resolve()
 const onDetach=()=>{owned=false;availability='detached'}
 const snapshot=()=>({availability,...(unavailableReason?{unavailableReason}:{}),requests:requests.map(r=>({...r}))})
 const onMessage=(_event,method,p={})=>{
  if(!active||!owned)return
  if(method==='Network.requestWillBeSent'){
   const target=relevantRequest(p.request?.url,identity.platformUserId)
   // Request IDs are browser identifiers, not public identity evidence.
   if(!target){inFlight.delete(p.requestId);return}
   const row={...target,atMs:now()-started,method:p.request.method==='GET'?'GET':'OTHER'}
   requests.push(row);if(requests.length>30)requests.shift();if(inFlight.size>=40)inFlight.delete(inFlight.keys().next().value);inFlight.set(p.requestId,row)
  }else if(method==='Network.responseReceived'){
   const row=inFlight.get(p.requestId);if(!row)return
   // Redirect responses cannot attach another account's result to this target.
   if(!relevantRequest(p.response?.url,identity.platformUserId)){inFlight.delete(p.requestId);return}
   row.httpStatus=Number(p.response.status)||0;row.mimeType=String(p.response.mimeType||'').slice(0,60)
  }else if(method==='Network.loadingFailed'){
   const row=inFlight.get(p.requestId);if(!row)return
   row.failure=/^net::[A-Z_]+$/.test(p.errorText||'')?p.errorText:'NETWORK_REQUEST_FAILED';row.cancelled=p.canceled===true;inFlight.delete(p.requestId)
  }else if(method==='Network.loadingFinished'){
   const row=inFlight.get(p.requestId);inFlight.delete(p.requestId)
   if(!row||row.kind!=='profile'||p.encodedDataLength>131072)return
   const task=bounded(Promise.resolve().then(()=>debug.sendCommand('Network.getResponseBody',{requestId:p.requestId})),500).then(result=>{
    if(!active)return
    const body=result.base64Encoded?Buffer.from(result.body||'','base64').toString('utf8'):result.body||''
    if(Buffer.byteLength(body)>131072)return
    row.responseBodyState=body.trim()?'present':'empty'
    if(!body.trim())return
    let data;try{data=JSON.parse(body)}catch{return}
    if(Number.isFinite(data.status_code))row.businessStatus=data.status_code
    if(data.status_code!==0&&data.status_msg)row.businessMessage=safeMessage(data.status_msg)
    // Do not read demographics or turn a hidden response into a public fact.
   }).catch(()=>{}).finally(()=>pending.delete(task));pending.add(task)
  }
 }
 try{
  if(!debug||debug.isAttached?.())availability=debug?'already_attached':'unavailable'
  else{
   debug.attach('1.3');owned=true;debug.on('message',onMessage);debug.on('detach',onDetach);availability='initializing'
   // A cold BrowserWindow has no renderer until navigation starts. Do not wait
   // for Network.enable before allowing that first navigation to create it.
   initializing=bounded(Promise.resolve().then(()=>debug.sendCommand('Network.enable',{maxTotalBufferSize:262144,maxResourceBufferSize:131072})),1500).then(()=>{if(active&&owned)availability='observing'}).catch(error=>{
    if(!active)return;availability='unavailable';unavailableReason=safeMessage(error.message)
    if(owned){debug.removeListener('message',onMessage);debug.removeListener('detach',onDetach);try{debug.detach()}catch{}owned=false}
   })
  }
 }catch(error){availability='unavailable';unavailableReason=safeMessage(error.message);if(owned){try{debug.removeListener('message',onMessage);debug.removeListener('detach',onDetach);debug.detach()}catch{}owned=false}}
 return {snapshot,async stop(){if(!active)return snapshot();await initializing;if(pending.size)await bounded(Promise.allSettled([...pending]),550).catch(()=>{});active=false;if(debug){debug.removeListener('message',onMessage);debug.removeListener('detach',onDetach)}if(owned){try{debug.detach()}catch{}}inFlight.clear();return snapshot()}}
}
module.exports={startProfileTrace,relevantRequest,safeMessage}
