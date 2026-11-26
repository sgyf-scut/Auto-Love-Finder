const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {createMemoryStorage}=require('./setup.cjs')
const {readPublicGender,PROFILE_READ_TIMEOUT_MS}=require('../electron/discovery/profile-reader.cjs')
const {DiscoveryEngine}=require('../electron/discovery/discovery-engine.cjs')
const identity={profileUrl:'https://www.douyin.com/user/fixture-profile',platformUserId:'fixture-profile'}
const publicRow=over=>({ready:true,hasHeader:true,identityStatus:'verified',observedPlatformUserIds:[identity.platformUserId],...identity,nickname:'本地模拟用户',rawText:'本地模拟用户',documentState:'complete',metadataLoading:false,...over})
function simulate(at,{cancelAt=Infinity}={}){
 const clock={now:0,calls:0};const current=()=>clock.now<cancelAt
 const navigate=async(win,url,{timeout,read})=>{clock.calls++;const end=clock.now+timeout;do{if(!current())return {ok:false,code:'READ_CANCELLED'};let r;try{r=await read(win,url,3000)}catch{clock.now+=250;continue}if(r.code)return {ok:false,code:r.code};if(r.ready)return {ok:true};clock.now+=250}while(clock.now<end);return {ok:false,code:'TIMEOUT'}}
 return {clock,run:()=>readPublicGender({},identity,{now:()=>clock.now,wait:async ms=>{clock.now+=ms},isCurrent:current,navigate,read:async()=>at(clock.now,clock.calls)})}
}
test('profile rendering after nine seconds is read successfully beyond the old 6.5-second limit',async()=>{const h=simulate(t=>t<9000?{ready:false}:publicRow({genderText:'女'})),r=await h.run();assert.equal(PROFILE_READ_TIMEOUT_MS,18000);assert.equal(r.status,'found');assert.ok(h.clock.now>=9500&&h.clock.now<18000)})
for(const genderText of ['女','男'])test(`explicit public ${genderText} has a stable fast path without waiting eighteen seconds`,async()=>{const h=simulate(()=>publicRow({genderText})),r=await h.run();assert.equal(r.status,'found');assert.equal(r.publicSignals.genderText,genderText);assert.equal(h.clock.now,500)})
test('genuinely absent gender is only returned after stable public fields',async()=>{const h=simulate(()=>publicRow()),r=await h.run();assert.equal(r.status,'not_present');assert.ok(h.clock.now>=2500);assert.equal(r.retryable,false)})
test('a metadata loader cannot turn an unfinished profile into gender-not-public',async()=>{const h=simulate(()=>publicRow({metadataLoading:true})),r=await h.run();assert.equal(r.status,'failed');assert.equal(r.code,'PROFILE_FIELDS_TIMEOUT');assert.equal(r.retryable,true);assert.equal(h.clock.now,18000)})
test('a late field can settle near the deadline and still be used',async()=>{const h=simulate(t=>publicRow({metadataLoading:t<17000,...(t>=17000?{genderText:'女'}:{})})),r=await h.run();assert.equal(r.status,'found');assert.equal(h.clock.now,17500)})
test('an actively loading document is not classified as stable absence',async()=>{const h=simulate(t=>publicRow({documentState:t<4000?'loading':'interactive'})),r=await h.run();assert.equal(r.status,'not_present');assert.ok(h.clock.now>=4000)})
test('changing header evidence must not be interpreted as a completed empty profile',async()=>{const h=simulate(t=>publicRow({rawText:'header '+Math.floor(t/500)})),r=await h.run();assert.equal(r.code,'PROFILE_FIELDS_TIMEOUT');assert.equal(r.status,'failed')})
test('persistent script timeouts retain the original error and bounded diagnostic history',async()=>{const h=simulate(()=>{throw Error('页面状态读取超时')}),r=await h.run();assert.equal(r.code,'PROFILE_SCRIPT_TIMEOUT');assert.match(r.diagnostics.lastScriptError,/读取超时/);assert.ok(r.diagnostics.scriptErrors>0);assert.ok(r.diagnostics.events.length<=15)})
test('temporary script errors can recover within the same profile budget',async()=>{let calls=0;const h=simulate(()=>{if(++calls<3)throw Error('Execution context changed');return publicRow({genderText:'女'})}),r=await h.run();assert.equal(r.status,'found');assert.equal(r.diagnostics.scriptErrors,2);assert.equal(h.clock.calls,1)})
for(const flag of ['challenge','loginRequired'])test(`${flag} stops immediately with no automatic retry`,async()=>{const h=simulate(()=>({[flag]:true})),r=await h.run();assert.equal(r.status,'blocked');assert.equal(r.retryable,false);assert.equal(h.clock.calls,1);assert.equal(h.clock.now,0)})
test('a different target never contributes gender and is not eligible for transient retry',async()=>{const h=simulate(()=>({wrongPage:true,genderText:'女'})),r=await h.run();assert.equal(r.code,'PROFILE_TARGET_MISMATCH');assert.equal(r.publicSignals,undefined);assert.equal(r.retryable,false)})
test('one early server error gets a bounded retry sharing the original deadline',async()=>{const h=simulate((t,attempt)=>attempt===1?{serverError:'502 Bad Gateway'}:publicRow({genderText:'女'})),r=await h.run();assert.equal(r.status,'found');assert.equal(h.clock.calls,2);assert.ok(h.clock.now<18000)})
test('repeated server errors never cause unbounded navigation attempts',async()=>{const h=simulate(()=>({serverError:'503 Service Unavailable'})),r=await h.run();assert.equal(r.code,'PROFILE_NETWORK_ERROR');assert.equal(h.clock.calls,2)})
test('stopping the task cancels without returning profile facts',async()=>{const h=simulate(()=>({ready:false}),{cancelAt:1000}),r=await h.run();assert.equal(r.status,'cancelled');assert.equal(r.publicSignals,undefined);assert.equal(h.clock.now,1000)})
test('stable conflicting public fields remain conflicting',async()=>{const h=simulate(()=>publicRow({genderConflict:true})),r=await h.run();assert.equal(r.status,'conflict');assert.equal(r.publicSignals.genderText,null)})
test('valid gender may be used while unrelated profile fields are still loading',async()=>{const h=simulate(()=>publicRow({genderText:'女',metadataLoading:true})),r=await h.run();assert.equal(r.status,'found');assert.equal(h.clock.now,500)})
test('profile failures save a local screenshot and metadata without URL query data',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profile-scene-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})});require('electron').app={getPath:()=>dir}
 const win={isDestroyed:()=>false,webContents:{getURL:()=>identity.profileUrl+'?private=omit',capturePage:async()=>({isEmpty:()=>false,toPNG:()=>Buffer.from('fixture png')})}}
 const r=await DiscoveryEngine.prototype.captureBatchProfileFailure.call({},win,{status:'failed',code:'PROFILE_HEADER_TIMEOUT',diagnostics:{expectedProfileUrl:identity.profileUrl}})
 assert.ok(fs.existsSync(r.diagnostics.screenshotPath));assert.ok(fs.existsSync(r.diagnostics.recordPath));assert.equal(r.diagnostics.currentPage,identity.profileUrl);assert.doesNotMatch(fs.readFileSync(r.diagnostics.recordPath,'utf8'),/private=omit/)
})
test('failed screenshot capture does not replace the profile failure classification',async()=>{const win={isDestroyed:()=>false,webContents:{getURL:()=>identity.profileUrl,capturePage:async()=>{throw Error('capture failed')}}};const r=await DiscoveryEngine.prototype.captureBatchProfileFailure.call({},win,{status:'failed',code:'PROFILE_FIELDS_TIMEOUT'});assert.equal(r.code,'PROFILE_FIELDS_TIMEOUT');assert.match(r.diagnostics.captureError,/capture failed/)})

test('script reads and navigation retries share the original eighteen-second deadline',async()=>{
 const clock={now:0},timeouts=[]
 const navigate=async(win,url,{read})=>{clock.now=17500;await read(win,url,3000);clock.now=17800;await read(win,url,3000);clock.now=18000;const result=await read(win,url,3000);return {ok:false,code:result.code}}
 const result=await readPublicGender({},identity,{now:()=>clock.now,navigate,read:async(win,code,timeout)=>{timeouts.push(timeout);return publicRow({genderText:'女'})}})
 assert.deepEqual(timeouts,[500,200]);assert.equal(result.status,'failed');assert.equal(result.code,'PROFILE_FIELDS_TIMEOUT')
})

test('a persistent user-not-found page is explicit, bounded, and never becomes unpublished gender',async()=>{
 const h=simulate(()=>({unavailable:true,unavailableText:'用户不存在',documentState:'complete'})),r=await h.run()
 assert.equal(r.code,'PROFILE_UNAVAILABLE');assert.equal(r.status,'failed');assert.equal(r.retryable,false)
 assert.equal(h.clock.now,500);assert.equal(h.clock.calls,1);assert.equal(r.publicSignals,undefined)
 assert.equal(r.diagnostics.pageMessage,'用户不存在');assert.match(r.reason,/不据此判定账号已注销/)
})
test('a transient router error can recover before the unavailable confirmation window',async()=>{
 const h=simulate(t=>t<250?{unavailable:true,unavailableText:'用户不存在'}:publicRow({genderText:'女'})),r=await h.run()
 assert.equal(r.status,'found');assert.equal(h.clock.now,750);assert.equal(h.clock.calls,1)
})
test('an unavailable message on the wrong target cannot terminate the requested profile',async()=>{
 const h=simulate(()=>({wrongPage:true,unavailable:true,unavailableText:'用户不存在'})),r=await h.run()
 assert.equal(r.code,'PROFILE_TARGET_MISMATCH');assert.equal(r.publicSignals,undefined)
})
test('verification and login still take precedence over profile-unavailable text',async()=>{
 for(const flag of ['challenge','loginRequired']){const h=simulate(()=>({[flag]:true,unavailable:true})),r=await h.run();assert.equal(r.status,'blocked');assert.equal(h.clock.now,0)}
})
