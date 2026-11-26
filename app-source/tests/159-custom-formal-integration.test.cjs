const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm')
const {createMemoryStorage}=require('./setup.cjs')
const {BatchRunner}=require('../electron/discovery/batch-runner.cjs')
const {CandidateManager}=require('../electron/discovery/candidate-manager.cjs')
const {LibraryStore}=require('../electron/social-brain/library-store.cjs')
const {CustomGoalStore,commentSample,candidateGoalOpeningInput}=require('../electron/discovery/custom-goals.cjs')
const {evaluateBatchCandidate}=require('../electron/discovery/batch-filter.cjs')
const {filterIntentPool}=require('../electron/discovery/discovery-lists.cjs')
const videoId='7700000000000011111',work={videoId,videoUrl:'https://www.douyin.com/video/'+videoId,title:'无畏契约游戏组队'}
function fixture(t,{gender='female',ip='湖南',reply=0}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'formal-custom-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const storage=createMemoryStorage(),manager=new CandidateManager(storage),libraryStore=new LibraryStore(dir),goalStore=new CustomGoalStore(dir)
 libraryStore.addVideo({key:'v:id:'+videoId,video_id:videoId,video_url:work.videoUrl,title:work.title})
 libraryStore.addComments([{video_id:videoId,comment_id:'one',author_id:'fixture-person',author_name:'测试',text:'晚上缺一，想一起组队',ip_location:ip,ip_location_source:'footer_region',reply_count:reply,classification:{intent:'ORDINARY',reviewedByUser:true}}])
 const samples=libraryStore.read().comments.map(c=>commentSample(c,{title:work.title}))
 const id=goalStore.setGoal({name:'游戏搭子',description:'寻找有游戏组队意愿的评论',openingInstructions:'先问区服'}).selectedId
 goalStore.recordSamples({id,version:1},samples);goalStore.review({id,version:1},samples[0].key,'match','明确组队')
 const target=goalStore.freeze(id,1)
 let profiles=0,defaultCalls=0
 const deps={storage,manager,libraryStore,goalStore,accountId:'fixture',enableVideoRounds:true,crossVideoClassification:true,retainIntentPool:true,
  classify:async()=>{defaultCalls++;throw Error('custom batch must not run dating classifier')},
  sourcesFactory:()=>({collectByKeyword:async()=>({ok:true,kind:'OK',videos:[work],pages:1,events:[]})}),
  collectorFactory:()=>({transport:{prepare:async()=>({ok:true,...work})},readPageWithRetry:async()=>({ok:true,rows:[],empty:true})}),
  engine:{readBatchGender:async()=>{profiles++;return {status:'found',publicSignals:{genderText:gender==='male'?'男':'女'},publicProfile:{rawText:gender==='male'?'性别：男':'性别：女'}}}}}
 const config={target:1,sources:{keywords:['组队']},filters:{gender},budgets:{maxAiCalls:0}}
 return {dir,storage,manager,libraryStore,goalStore,target,config,deps,profiles:()=>profiles,defaultCalls:()=>defaultCalls}
}
test('custom sampling and classification remain isolated under the real formal dependency flags',async t=>{
 const f=fixture(t),runner=new BatchRunner(f.deps)
 const result=await runner.start(f.config,{targetSnapshot:f.target})
 assert.equal(result.batch.stopCode,'TARGET_REACHED');assert.equal(result.batch.crossVideoClassification,false);assert.equal(f.defaultCalls(),0)
 assert.equal(f.profiles(),1);assert.equal(result.cards[0].gender,'female');assert.equal(result.cards[0].goalMatch.label,'match')
 assert.equal(f.manager.get().candidates.length,1);assert.equal(f.manager.get().candidates[0].goalMatches[0].id,f.target.id)
 assert.equal(f.libraryStore.read().comments[0].classification.intent,'ORDINARY')
})
test('custom matching still applies region and reply limits before opening a profile',async t=>{
 const f=fixture(t,{ip:'浙江',reply:3}),runner=new BatchRunner(f.deps)
 const result=await runner.start({...f.config,filters:{gender:'female',requireIp:true,ipValues:['湖南'],requireReplyLimit:true,replyLimit:0}},{targetSnapshot:f.target})
 assert.equal(result.cards.length,0);assert.equal(f.profiles(),0)
 const c=f.manager.get().candidates[0];assert.equal(c.goalMatches[0].label,'match');assert.equal(c.intentPoolOnly,true)
 assert.ok(c.batchScreening.reasons.includes('IP_MISMATCH'));assert.ok(c.batchScreening.reasons.includes('REPLIES_OUT_OF_RANGE'))
})
test('gaming goals honor any/male/female filters without inheriting the legacy dating male exclusion',()=>{
 const c={libraryIntent:'UNKNOWN',publicSignals:{genderText:'男'},sources:[]},match={label:'match'}
 assert.equal(evaluateBatchCandidate(c,{gender:'any'},undefined,match).status,'qualified')
 assert.equal(evaluateBatchCandidate(c,{gender:'male'},undefined,match).status,'qualified')
 assert.ok(evaluateBatchCandidate(c,{gender:'female'},undefined,match).reasons.includes('GENDER_MISMATCH'))
 assert.ok(evaluateBatchCandidate({...c,libraryIntent:'SEEKING_FRIENDS'},{gender:'any'}).reasons.includes('GENDER_MISMATCH'))
 assert.ok(evaluateBatchCandidate({libraryIntent:'UNKNOWN',sources:[]},{gender:'female'},undefined,match).pendingReasons.includes('GENDER_UNVERIFIED'))
})
test('custom matches with missing public gender stay in all candidates after an insufficient batch',async t=>{
 const f=fixture(t);f.deps.engine.readBatchGender=async()=>({status:'not_present',publicSignals:{},publicProfile:{rawText:'资料未公开'}})
 const runner=new BatchRunner(f.deps),result=await runner.start(f.config,{targetSnapshot:f.target})
 assert.equal(result.cards.length,0);const c=f.manager.get().candidates[0]
 assert.equal(c.intentPoolOnly,true);assert.equal(c.goalMatches[0].label,'match');assert.equal(c.batchScreening.status,'pending')
 assert.equal(f.defaultCalls(),0)
})
test('manual stop during custom profile checking retains the already-matched candidate and raw comment',async t=>{
 const f=fixture(t),runner=new BatchRunner(f.deps)
 f.deps.engine.readBatchGender=async()=>{runner.stop();return {status:'cancelled'}}
 const result=await runner.start(f.config,{targetSnapshot:f.target})
 assert.equal(result.batch.status,'stopped');assert.equal(result.cards.length,0)
 const c=f.manager.get().candidates[0];assert.equal(c.goalMatches[0].label,'match');assert.equal(c.intentPoolOnly,true)
 assert.equal(f.libraryStore.read().comments.length,1);assert.equal(f.defaultCalls(),0)
})
test('global-candidate opening uses stored goal identity and exact matched evidence, rejecting forged references',async t=>{
 const f=fixture(t),result=await new BatchRunner(f.deps).start(f.config,{targetSnapshot:f.target}),c=f.manager.get().candidates[0],match=c.goalMatches[0]
 const ref={id:match.id,version:match.version,snapshotId:match.snapshotId,key:match.key}
 const input=candidateGoalOpeningInput(f.goalStore,c,ref)
 assert.equal(input.commentText,'晚上缺一，想一起组队');assert.equal(input.openingGoal.description,'寻找有游戏组队意愿的评论');assert.equal(input.openingGoal.instructions,'先问区服')
 assert.throws(()=>candidateGoalOpeningInput(f.goalStore,c,{...ref,id:'other'}),/变化/)
 assert.throws(()=>candidateGoalOpeningInput(f.goalStore,c,{...ref,key:'other'}),/变化/)
 assert.throws(()=>candidateGoalOpeningInput(f.goalStore,c,{...ref,snapshotId:'other'}),/变化/)
 assert.equal(c.consentToDm,false);assert.equal(result.cards.length,1)
})
test('manual default-intent correction does not erase custom goal evidence or prior send receipts',async t=>{
 const f=fixture(t);await new BatchRunner(f.deps).start(f.config,{targetSnapshot:f.target})
 const c=f.manager.get().candidates[0],before=structuredClone(c.goalMatches)
 f.manager.patch(c.id,{review:{realContact:{messageStatus:'sent',text:'已发送'}}});f.manager.setIntent(c.id,'CONTEXTUAL_INTEREST')
 const after=f.manager.get().candidates[0];assert.deepEqual(after.goalMatches,before);assert.equal(after.review.realContact.messageStatus,'sent')
})
test('all-candidate filtering uses the selected custom goal without overwriting other goal evidence',async t=>{
 const f=fixture(t);await new BatchRunner(f.deps).start(f.config,{targetSnapshot:f.target})
 const c=f.manager.get().candidates[0],matches=structuredClone(c.goalMatches)
 const ref={id:f.target.id,version:f.target.version}
 assert.equal(filterIntentPool(f.manager,{gender:'female',requireIp:true,ipValues:['湖南']},ref).counts.qualified,1)
 assert.equal(filterIntentPool(f.manager,{},null).counts.qualified,0)
 assert.equal(filterIntentPool(f.manager,{}, {...ref,id:'another'}).counts.qualified,0)
 assert.deepEqual(f.manager.get().candidates[0].goalMatches,matches)
})
test('a custom goal never bypasses a later manual do-not-contact correction',async t=>{
 const f=fixture(t);await new BatchRunner(f.deps).start(f.config,{targetSnapshot:f.target})
 const c=f.manager.get().candidates[0],m=c.goalMatches[0],ref={id:m.id,version:m.version,snapshotId:m.snapshotId,key:m.key}
 f.manager.setIntent(c.id,'DO_NOT_CONTACT')
 assert.throws(()=>candidateGoalOpeningInput(f.goalStore,f.manager.get().candidates[0],ref),/拒绝保护/)
 assert.equal(filterIntentPool(f.manager,{},ref).counts.qualified,0)
})
