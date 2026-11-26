const {test}=require('node:test'),assert=require('node:assert/strict')
const {createMemoryStorage}=require('./setup.cjs')
const {BatchRunner}=require('../electron/discovery/batch-runner.cjs')
const {CandidateManager}=require('../electron/discovery/candidate-manager.cjs')
function harness(intents,{authors=[],texts=[],engine}={}){
 const vid='7300000000000000001',url=`https://www.douyin.com/video/${vid}`
 let data={videos:[{video_id:vid,video_url:url,title:'认识新朋友找搭子',classification:{category:'friend_general'}}],comments:intents.map((intent,i)=>({key:`c:${i}`,comment_id:String(i),video_id:vid,author_id:authors[i]||`fixture-${i}`,author_name:`本地用户${i}`,text:texts[i]||'报名',reply_count:0,ip_location:'广东',classification:{intent,confidence:.9,evidence:[]}}))}
 const storage=createMemoryStorage({contacts:[]}),manager=new CandidateManager(storage),calls=[]
 const library={read:()=>structuredClone(data),save:v=>data=structuredClone(v),addVideo:()=>{},addComments:()=>({added:0})}
 const runner=new BatchRunner({storage,manager,libraryStore:library,accountId:'fixture',engine,enableVideoRounds:true,draftOpening:null,emit:()=>{},sourcesFactory:()=>({async collectByTag(){return {ok:true,videos:[{videoId:vid,videoUrl:url,title:'认识新朋友找搭子',commentCount:200}],pages:1}}}),collectorFactory:()=>({transport:{async prepare(){calls.push('prepare');return {ok:true,videoId:vid}}},async readPageWithRetry(){calls.push('read');return {ok:true,rows:[],empty:true}}})})
 return {runner,manager,library,calls,vid,run:config=>runner.start({target:20,minVideoComments:0,sources:{tags:['搭子']},...config}),progress:()=>runner.videoProgress({videoId:vid})}
}

test('new batch clears all age counters from an older batch',async()=>{const h=harness(['ORDINARY']);h.manager.save({...h.manager.get(),batch:{id:'old',status:'done',progress:{ageFound:11,ageMissing:12,ageErrors:1,ageConflicts:2},added:[]}});const r=await h.run({target:1});for(const key of ['ageFound','ageMissing','ageErrors','ageConflicts'])assert.equal(r.batch.progress[key],0)})
