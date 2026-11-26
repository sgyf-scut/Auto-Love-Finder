const {navigateReadable,executePageScript}=require('./page-readiness.cjs')
const {publicProfileSnapshot,summarizePublicProfile}=require('./comment-snapshot.cjs')
const {readVisibleGenderGlyphs}=require('./gender-glyph.cjs')
const {publicAge}=require('./public-age.cjs')
const PROFILE_READ_TIMEOUT_MS=18000
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
// Read public DOM until facts or stable absence are established. The entire
// operation (including one early transient retry) shares one deadline.
async function readPublicGender(win,identity,{requiredFields=['gender'],isCurrent=()=>true,timeoutMs=PROFILE_READ_TIMEOUT_MS,initialDocumentKey='',now=Date.now,wait=pause,navigate=navigateReadable,onObservation=()=>{},read=(window,code,timeout)=>executePageScript(window,code,timeout)}={}){
 const fields=[...new Set(requiredFields)].filter(x=>['gender','age'].includes(x));if(!fields.length)fields.push('gender')
 const genderOnly=fields.length===1&&fields[0]==='gender'
 const started=now(),deadline=started+timeoutMs
 let latest=null,stableKey=null,stableSince=null,unavailableSince=null,lastSnapshot=null,lastScriptError='',scriptErrors=0,polls=0,navigationAttempts=0,result=null
 const events=[],pageTransitions=[];let lastObservation=''
 const record=(phase,extra={})=>{events.push({atMs:now()-started,phase,...extra});if(events.length>15)events.shift()}
 const diagnostics=()=>({stage:'public_profile',expectedProfileUrl:identity.profileUrl,expectedPlatformUserId:identity.platformUserId,elapsedMs:now()-started,polls,navigationAttempts,scriptErrors,lastScriptError,
  publicFieldEvidence:latest?{gender:latest.genderEvidence||[],age:latest.publicAge?.evidence||[],visibleText:String(latest.rawText||'').slice(0,1800),unlabelledIconCount:latest.unlabelledIconCount||0}:null,
  headerSeen:!!latest,documentState:lastSnapshot?.documentState||'',metadataLoading:lastSnapshot?.metadataLoading===true,
  ...(lastSnapshot?.unavailableText?{pageMessage:lastSnapshot.unavailableText}:{}),events,pageTransitions})
 const cancelled=()=>({status:'cancelled',code:'READ_CANCELLED',reason:'核验任务已停止或账号已切换',retryable:false,diagnostics:diagnostics()})
 for(let attempt=0;attempt<2;attempt++){
  if(!isCurrent())return cancelled()
  const previousDocumentKey=attempt===0?initialDocumentKey:lastSnapshot?.documentKey||''
  navigationAttempts++;record('navigation',{attempt:navigationAttempts})
  result=await navigate(win,identity.profileUrl,{timeout:Math.max(1,deadline-now()),interval:250,isCurrent,
   read:async(window,url,timeout)=>{
    if(!isCurrent())return {code:'READ_CANCELLED'}
    if(now()>=deadline)return {code:'PROFILE_READ_DEADLINE'}
    let snapshot
    try{polls++;snapshot=await read(window,`(async () => { const take = ${publicProfileSnapshot.toString()}; const first = take(${JSON.stringify(url)}); if (!first.ready || first.genderText || first.genderConflict) return first; const glyph = await (${readVisibleGenderGlyphs.toString()})(); const last = take(${JSON.stringify(url)}); if (glyph && last.ready && !last.genderText && !last.genderConflict && last.documentKey === first.documentKey && last.platformUserId === first.platformUserId) { last.genderText = glyph.value; last.genderEvidence = [...(last.genderEvidence || []),glyph]; } return last; })()`,Math.max(1,Math.min(timeout,deadline-now())))}
    catch(error){scriptErrors++;lastScriptError=String(error.message||error).replace(/\s+/g,' ').slice(0,220);record('script_error',{error:lastScriptError});throw error}
    if(!isCurrent())return {code:'READ_CANCELLED'}
    lastSnapshot=snapshot
    const observation={pageUrl:String(snapshot?.pageUrl||'').slice(0,500),documentKey:snapshot?.documentKey||'',hasHeader:snapshot?.hasHeader===true,identityStatus:snapshot?.identityStatus||'',observedPlatformUserIds:(snapshot?.observedPlatformUserIds||[]).slice(0,4),displayedName:String(snapshot?.nickname||'').slice(0,100),hasPublicGender:!!snapshot?.genderText,unavailable:snapshot?.unavailable===true,challenge:snapshot?.challenge===true,wrongPage:snapshot?.wrongPage===true,documentState:snapshot?.documentState||''}
    const key=JSON.stringify(observation)
    if(key!==lastObservation){lastObservation=key;pageTransitions.push({atMs:now()-started,...observation});if(pageTransitions.length>20)pageTransitions.shift();try{onObservation(snapshot)}catch{}}
    if(snapshot?.challenge)return {code:'CHALLENGE'}
    // loadURL is asynchronous even for the same URL: until a new document
    // commits, neither old profile facts nor old terminal errors are usable.
    if(previousDocumentKey&&snapshot?.documentKey===previousDocumentKey)return {ready:false}
    if(snapshot?.loginRequired)return {code:'LOGIN_REQUIRED'}
    if(snapshot?.serverError)return {code:'NETWORK_ERROR'}
    if(snapshot?.unavailable&&!snapshot?.wrongPage){
     latest=null;stableKey=null;stableSince=null
     if(snapshot.networkStatus>=500||snapshot.networkFailed)return {code:'NETWORK_ERROR'}
     if(snapshot.networkStatus===403||snapshot.networkStatus===429)return {code:'PROFILE_ACCESS_RESTRICTED'}
     if(unavailableSince===null){unavailableSince=now();record('profile_unavailable_seen')}
     // Brief router transitions may retain an error. Confirm it across polls,
     // without spending the whole rendering deadline on a terminal page.
     if(now()-unavailableSince>=500){record('profile_unavailable_confirmed');return {code:'PROFILE_UNAVAILABLE'}}
     return {ready:false}
    }
    unavailableSince=null
    if(snapshot?.ready&&snapshot.identityStatus==='verified'&&snapshot.profileUrl===identity.profileUrl&&snapshot.platformUserId===identity.platformUserId){
     snapshot.publicAge=publicAge(snapshot,{now:new Date(now())})
     latest=snapshot
     const key=JSON.stringify([snapshot.nickname,snapshot.rawText,snapshot.genderText||'',snapshot.genderConflict===true,snapshot.publicAge])
     if(key!==stableKey){stableKey=key;stableSince=now();record('header_or_fields_changed')}
     const stableMs=now()-stableSince
     const known={gender:!!(snapshot.genderText||snapshot.genderConflict),age:snapshot.publicAge.status!=='not_present'}
     if(fields.every(field=>known[field])&&stableMs>=500){record('requested_public_fields_ready');return {ready:true}}
     if(stableMs>=2500&&!snapshot.metadataLoading&&snapshot.documentState!=='loading'){
      record('stable_public_absence');return {ready:true}
     }
    }else{latest=null;stableKey=null;stableSince=null}
    return {ready:false}
   }})
  if(!isCurrent()||result.code==='READ_CANCELLED')return cancelled()
  if(result.ok)break
  if(attempt===0&&result.code==='NETWORK_ERROR'&&deadline-now()>1000){record('transient_retry');latest=null;stableKey=null;stableSince=null;await wait(500);continue}
  break
 }
 const detail=diagnostics()
 if(['CHALLENGE','LOGIN_REQUIRED','PROFILE_ACCESS_RESTRICTED'].includes(result?.code))return {status:'blocked',code:result.code,reason:result.code==='CHALLENGE'?'主页要求手动完成安全验证':result.code==='LOGIN_REQUIRED'?'主页需要重新登录':`主页资料请求返回 ${lastSnapshot?.networkStatus}，已暂停读取，请稍后手动继续`,retryable:false,diagnostics:detail}
 if(result?.code==='PROFILE_UNAVAILABLE')return {status:'failed',code:'PROFILE_UNAVAILABLE',reason:'抖音页面提示“用户不存在”，本批跳过该主页；不据此判定账号已注销',retryable:false,diagnostics:detail}
 if(!result?.ok||!latest){
  const mismatch=lastSnapshot?.wrongPage===true
  const code=mismatch?'PROFILE_TARGET_MISMATCH':scriptErrors&&!latest?'PROFILE_SCRIPT_TIMEOUT':latest?'PROFILE_FIELDS_TIMEOUT':result?.code==='NETWORK_ERROR'?'PROFILE_NETWORK_ERROR':lastSnapshot?.identityStatus==='mismatch'?'PROFILE_HEADER_IDENTITY_MISMATCH':lastSnapshot?.hasHeader?'PROFILE_IDENTITY_PENDING':'PROFILE_HEADER_TIMEOUT'
  const reasons={PROFILE_TARGET_MISMATCH:'实际主页与候选账号不一致，未采用页面资料',PROFILE_SCRIPT_TIMEOUT:'主页脚本未及时响应，未能完成公开资料读取',PROFILE_FIELDS_TIMEOUT:'主页信息仍在加载或尚未稳定，未将所需资料记为未公开',PROFILE_NETWORK_ERROR:'主页返回网络或服务错误',PROFILE_HEADER_TIMEOUT:'在等待上限内没有读到目标账号的公开资料区',PROFILE_HEADER_IDENTITY_MISMATCH:'资料区仍属于其他账号，未采用其公开资料',PROFILE_IDENTITY_PENDING:'资料区已出现，但账号身份尚未核实，未采用其公开资料'}
  return {status:'failed',code,reason:reasons[code],retryable:!mismatch,diagnostics:{...detail,navigationCode:result?.code||'',navigationError:result?.navigationError||'',ignoredNavigationError:result?.ignoredNavigationError||''}}
 }
 const fieldStatuses={gender:latest.genderConflict?'conflict':latest.genderText?'found':'not_present',age:latest.publicAge.status}
 const statuses=fields.map(field=>fieldStatuses[field])
 const status=statuses.includes('conflict')?'conflict':statuses.includes('found')?'found':'not_present'
 const label=genderOnly?'性别':fields.map(x=>x==='gender'?'性别':'年龄').join('、')
 return {status,code:(genderOnly?'PROFILE_GENDER_':'PROFILE_FACTS_')+({found:'FOUND',conflict:'CONFLICT',not_present:'NOT_PUBLIC'}[status]),
  reason:status==='not_present'?`公开资料已稳定，但未识别到${label}的公开字段`:status==='conflict'?`公开${label}字段存在冲突`:`读到公开资料；${fields.map(x=>(x==='gender'?'性别':'年龄')+({found:'已读到',not_present:'未公开',conflict:'有冲突'}[fieldStatuses[x]])).join('，')}`,
  requestedFields:fields,fieldStatuses,retryable:false,publicProfile:{...latest,capturedAt:new Date(now()).toISOString()},publicSignals:summarizePublicProfile(latest),diagnostics:detail}

}
module.exports={readPublicGender,PROFILE_READ_TIMEOUT_MS}
