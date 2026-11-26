const {executePageScript}=require('./page-readiness.cjs')
const {requestManualVerification}=require('../manual-verification.cjs')
const {verificationSnapshot}=require('./verification-dom.cjs')
async function checkVerification(douyin,windows,{read=executePageScript,notify=requestManualVerification}={}){
 const seen=new Set()
 for(const entry of windows){const win=entry?.win;if(!win||seen.has(win)||win.isDestroyed?.())continue;seen.add(win)
  let result;try{result=await read(win,`(${verificationSnapshot.toString()})()`,1500)}catch{return {ok:false,code:'VERIFICATION_CHECK_UNAVAILABLE',reason:`暂时无法检查“${entry.source}”的验证状态，请稍后点继续`,source:entry.source}}
  if(result?.challenge){notify(douyin,win,{source:entry.source});return {ok:false,code:'CHALLENGE',reason:`请在“${entry.source}”手动完成安全验证，再点继续`,source:entry.source,windowId:win.id||null,evidence:result.evidence||null}}
 }
 // The automation owner clears its own account-wide flag. Never bypass it just
 // because a different window is readable or a navigation has started.
 if(douyin?.verificationActive)return {ok:false,code:'CHALLENGE',reason:'账号仍处于安全验证状态，请在登录窗口完成验证，待状态更新后点继续',source:'登录窗口'}
 return {ok:true}
}
module.exports={verificationSnapshot,checkVerification}
