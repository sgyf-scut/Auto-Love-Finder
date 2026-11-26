const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {publicProfileSnapshot}=require('../electron/discovery/comment-snapshot.cjs')
const url='https://www.douyin.com/user/offline-user'
function snapshot(body,{header=false,location=url,challenge=false}={}){
 const publicHeader=header?{__reactPropsTest:{userInfo:{secUid:'offline-user'}},getBoundingClientRect:()=>({width:100,height:50}),querySelector:()=>({innerText:'本地用户'}),parentElement:{innerText:'本地用户\n用户不存在\n女'}}:null
 return vm.runInNewContext(`(${publicProfileSnapshot.toString()})(${JSON.stringify(url)})`,{location:new URL(location),document:{title:'本地资料测试',readyState:'complete',body:{innerText:body},querySelector:()=>publicHeader,querySelectorAll:()=>challenge?[{tagName:'IFRAME',src:'https://rmc.bytedance.com/verifycenter/puzzle',getBoundingClientRect:()=>({width:300,height:200})}]:[]}})
}
for(const message of ['用户不存在','该用户不存在','你访问的用户不存在'])test(`same-target public error line ${message} is classified without a profile header`,()=>{
 const s=snapshot('搜索\n消息\n'+message+'\n');assert.equal(s.unavailable,true);assert.equal(s.unavailableText,message);assert.equal(s.ready,false);assert.equal(s.genderText,undefined)
})
test('error words in a biography do not override a visible public header',()=>{const s=snapshot('用户不存在',{header:true});assert.equal(s.unavailable,undefined);assert.equal(s.genderText,'女')})
test('quotations and unrelated sentences do not count as terminal error pages',()=>{assert.equal(snapshot('有人说用户不存在，但我也不知道').unavailable,undefined)})
test('other-profile error pages remain identity mismatches',()=>{assert.equal(snapshot('用户不存在',{location:'https://www.douyin.com/user/another-user'}).wrongPage,true)})
test('a visible verification stops error-page classification',()=>{assert.equal(snapshot('用户不存在',{challenge:true}).challenge,true)})
test('login is reported alongside the snapshot and takes precedence in the reader',()=>{const s=snapshot('请先登录\n用户不存在');assert.equal(s.loginRequired,true)})

const ui=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8'),view=ui.match(/function batchProfileReadView\(b\) \{[\s\S]*?\n\}/)[0]
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const render=b=>vm.runInNewContext(`(${view})(${JSON.stringify(b)})`,{esc})
test('profile diagnostics expose source video, exact comment, and distinct unavailable status',()=>{
 const html=render({genderReadResults:[{nickname:'本地样本',status:'failed',code:'PROFILE_UNAVAILABLE',sourceVideoId:'7711297068606484721',sourceCommentText:'想找个聊天搭子',profileUrl:url,reason:'页面提示用户不存在'}]})
 assert.match(html,/主页未能核验（本批跳过）/);assert.match(html,/href="https:\/\/www.douyin.com\/video\/7711297068606484721"/);assert.match(html,/原评论：想找个聊天搭子/);assert.ok(html.includes(`href="${url}"`))
})
test('profile diagnostics reject injected links and escape untrusted comment text',()=>{
 const html=render({genderReadResults:[{nickname:'<script>',status:'failed',sourceVideoId:'1" onclick="bad',profileUrl:'javascript:bad()',sourceCommentText:'<img src=x>'}]})
 assert.doesNotMatch(html,/href=|<script>|<img/);assert.match(html,/&lt;img src=x&gt;/)
})
test('old batches without new source fields still render and retain their actual failure reason',()=>{const html=render({genderReadResults:[{status:'failed',reason:'旧批次超时'}]});assert.match(html,/旧批次超时/);assert.doesNotMatch(html,/undefined|原视频|核验主页/);assert.equal(render({}), '')})
