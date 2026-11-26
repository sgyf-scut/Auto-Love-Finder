const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {createMemoryStorage}=require('./setup.cjs')
const {BatchRunner,normalizeBatchConfig}=require('../electron/discovery/batch-runner.cjs')
const {CandidateManager}=require('../electron/discovery/candidate-manager.cjs')
const {createVideoReader}=require('../electron/discovery/video-rounds.cjs')
const {normalizeVideoCommentCount,belowCommentMinimum,videoCommentCountSnapshot}=require('../electron/discovery/video-comment-count.cjs')
const a='7711224680274914762'
test('new batches default to twenty total comments and zero explicitly disables the gate',()=>{assert.equal(normalizeBatchConfig({}).minVideoComments,20);assert.equal(normalizeBatchConfig({minVideoComments:0}).minVideoComments,0)})
test('zero and nineteen are below the gate; twenty and unknown are not',()=>{for(const n of [0,19,'19'])assert.equal(belowCommentMinimum(n,20),true);for(const n of [20,21,null,undefined,'',false,-1])assert.equal(belowCommentMinimum(n,20),false)})
test('comment count normalization never converts missing or boolean evidence into zero',()=>{for(const v of [null,undefined,'',false,true,-1,NaN])assert.equal(normalizeVideoCommentCount(v),null);assert.equal(normalizeVideoCommentCount('0'),0)})
function harness(rounds,min=20){
 const visited=[],ids=[1,2,3,4].map(n=>String(BigInt(a)+BigInt(n)));const videos=ids.map((videoId,i)=>({videoId,videoUrl:'https://www.douyin.com/video/'+videoId,commentCount:[0,19,20,null][i]}))
 const storage=createMemoryStorage(),manager=new CandidateManager(storage),library={read:()=>({comments:[],videos:[]}),addVideo(){},addComments(){return {added:0}}}
 const collectorFactory=()=>({transport:{prepare:async({videoId})=>{visited.push(videoId);return {ok:true,videoId}}},readPageWithRetry:async()=>({ok:true,empty:true,rows:[]}),run:async({videoId})=>{visited.push(videoId);return {ok:true,empty:true,added:0,fetched:0}}})
 const runner=new BatchRunner({storage,manager,libraryStore:library,enableVideoRounds:rounds,collectorFactory,sourcesFactory:()=>({collectByTag:async()=>({ok:true,kind:'OK',videos,events:[]})})})
 return {visited,ids,runner,run:()=>runner.start({sources:{tags:['搭子']},minVideoComments:min})}
}
for(const rounds of [true,false])test(`known low-comment videos are skipped before opening in ${rounds?'round':'legacy'} collection`,async()=>{
 const h=harness(rounds),r=await h.run();assert.deepEqual(h.visited,h.ids.slice(2));assert.equal(r.batch.progress.videosLowComments,2);assert.equal(r.batch.queue[0].code,'VIDEO_COMMENTS_BELOW_MIN');assert.equal(r.batch.queue[0].status,'skipped');assert.equal(r.batch.progress.videosFailed,0);assert.equal(r.batch.progress.aiCalls,0)
})
test('disabling the gate preserves collection of low-comment videos',async()=>{const h=harness(true,0);await h.run();assert.deepEqual(h.visited,h.ids)})
function snapshot(labels,wrong=false){
 const node=(label)=>({innerText:label,getBoundingClientRect:()=>({width:50,height:20})})
 return vm.runInNewContext(`(${videoCommentCountSnapshot.toString()})('${a}')`,{location:{origin:'https://www.douyin.com',href:'https://www.douyin.com/video/'+(wrong?'7711219897677687270':a)},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{querySelectorAll:s=>s.includes('role="tab"')?labels.map(node):[]}})
}
test('only an explicit same-video total is used, with exact twenty retained',()=>{assert.equal(snapshot(['评论(19)']),19);assert.equal(snapshot(['评论（20）']),20);assert.equal(snapshot(['评论(1,234)']),1234);assert.equal(snapshot(['评论(19)'],true),null)})
test('conflicting, abbreviated or absent totals remain unknown rather than guessed',()=>{assert.equal(snapshot(['评论(19)','评论(20)']),null);assert.equal(snapshot(['评论(1.2万)']),null);assert.equal(snapshot(['点赞19']),null)})
test('a count confirmed after opening stops the round reader before storing or classifying rows',async()=>{
 let saves=0;const library={read:()=>({comments:[]}),addVideo(){},addComments(){saves++;return {added:1}}}
 const read=createVideoReader({transport:{prepare:async()=>({ok:true,videoId:a})},readPageWithRetry:async()=>({ok:true,videoCommentCount:19,rows:[{commentText:'fixture',platformUserId:'fixture'}]})},library,{videoId:a},{minVideoComments:20})
 const result=await read({limit:20,alive:()=>true});assert.equal(result.code,'VIDEO_COMMENTS_BELOW_MIN');assert.equal(result.read,0);assert.equal(saves,0)
})
test('a short sampled page is not mistaken for the video total when the total is unknown',async()=>{
 let calls=0;const read=createVideoReader({transport:{prepare:async()=>({ok:true,videoId:a})},readPageWithRetry:async()=>++calls===1?{ok:true,videoCommentCount:null,rows:[{commentText:'one visible comment',platformUserId:'fixture'}]}:{ok:true,rows:[],empty:true}},{read:()=>({comments:[]}),addVideo(){},addComments:()=>({added:1})},{videoId:a},{minVideoComments:20})
 const result=await read({limit:20,alive:()=>true});assert.equal(result.ok,true);assert.equal(result.read,1)
})
test('the UI form preserves zero and submits the configured total-comment minimum',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8'),fn=source.match(/function readBatchConfig\(\) \{[\s\S]*?\n\}/)[0]
 for(const [value,expected] of [['0',0],['20',20],['',20]]){const document={getElementById:id=>id==='batch-min-video-comments'?{value}:null};assert.equal(vm.runInNewContext(`(${fn})()`,{document}).minVideoComments,expected)}
})

test('a numeric count next to its comment icon is readable without using nearby like/share counts',()=>{
 const n={innerText:'',parentElement:{innerText:'19'},getBoundingClientRect:()=>({width:20,height:20})}
 const context={location:{origin:'https://www.douyin.com',href:'https://www.douyin.com/video/'+a},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{querySelectorAll:s=>s.includes('video-player-comment')?[n]:[]}}
 assert.equal(vm.runInNewContext(`(${videoCommentCountSnapshot.toString()})('${a}')`,context),19)
 n.parentElement.innerText='42\n19\n10';assert.equal(vm.runInNewContext(`(${videoCommentCountSnapshot.toString()})('${a}')`,context),null)
})

test('the real legacy collector honors the page-confirmed minimum without saving low-count comments',async t=>{
 const os=require('node:os'),{LibraryStore}=require('../electron/social-brain/library-store.cjs'),{CommentCollector}=require('../electron/social-brain/comment-collector.cjs')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'comment-minimum-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})})
 const store=new LibraryStore(dir),collector=new CommentCollector({store,transport:{prepare:async()=>({ok:true,videoId:a,videoUrl:'https://www.douyin.com/video/'+a}),readPage:async payload=>{assert.equal(payload.minVideoComments,20);return {ok:true,videoCommentCount:19,rows:[{commentText:'fixture',platformUserId:'fixture'}]}}}})
 const result=await collector.run({videoId:a,minVideoComments:20});assert.equal(result.code,'VIDEO_COMMENTS_BELOW_MIN');assert.equal(store.read().comments.length,0)
})
