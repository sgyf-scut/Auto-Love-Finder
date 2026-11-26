const {test}=require('node:test')
const assert=require('node:assert/strict')
require('./setup.cjs')
const {buildContext}=require('../electron/social-brain/context-builder.cjs')
const {parsePlan}=require('../electron/social-brain/conversation-planner.cjs')
const {writeReply}=require('../electron/social-brain/reply-writer.cjs')
const now=new Date(),m=(id,role,text,offset=0)=>({id,role,text,at:new Date(now.getTime()+offset).toISOString()})
const contact=()=>({id:'test',profile:{chatMode:'friendship'},learning:{messages:[m('topic','contact','准备考研，目标北航，不过感觉很难'),m('reaction','contact','哈哈哈哈')]}})
const planFor=ctx=>parsePlan(JSON.stringify({plan:{shouldReply:true,action:'FOLLOW_UP',goal:'继续考研目标话题',allowQuestion:true},learning:{enabled:false}}),ctx)
test('actually observed outgoing draft consumes selected focus without lexical overlap',()=>{
  const c=contact();c.learning.relationshipPlan={focusMessageId:'topic',generatedReply:'留个稳一点的备选也行',at:new Date(now.getTime()-1000).toISOString()}
  c.learning.messages.push(m('sent','me','留个稳一点的备选也行'),m('ack','contact','好'))
  const ctx=buildContext({contact:c,incoming:'好',now})
  assert.equal(ctx.attention.selectedFocus,null);assert.equal(ctx.attention.recommendedMode,'NO_REPLY')
})
test('generated draft alone never consumes focus',()=>{
  const c=contact();c.learning.relationshipPlan={focusMessageId:'topic',generatedReply:'留个稳一点的备选也行',at:now.toISOString()}
  const ctx=buildContext({contact:c,incoming:'哈哈哈哈',now})
  assert.equal(ctx.attention.selectedFocus.messageId,'topic');assert.equal(ctx.attention.state.processedFocusIds.length,0)
})
test('expired event cannot supply a new topic after plain acknowledgement',()=>{
  const c=contact();c.learning.messages=[m('ack','contact','好')];c.socialBrain={events:[{id:'evt',description:'面试',status:'due',sourceMessageIds:['e1'],followUpAt:new Date(now.getTime()-7200000).toISOString(),followUpWindow:{startAt:new Date(now.getTime()-7200000).toISOString(),endAt:new Date(now.getTime()-3600000).toISOString()},followUp:{enabled:true,status:'pending'}}]}
  const ctx=buildContext({contact:c,incoming:'好',now});assert.equal(ctx.attention.topicSource,null);assert.equal(ctx.attention.recommendedMode,'NO_REPLY')
})
test('grounded target school followup does not open unknown current-school identity',async()=>{
  const ctx=buildContext({contact:contact(),incoming:'哈哈哈哈',now}),plan=planFor(ctx)
  const result=await writeReply(async()=>({text:'目标学校除了北航，还有备选学校没？'}),ctx,plan)
  assert.match(result.text,/北航/);assert.equal(ctx.memory.profile.identity.school.status,'unknown')
  await assert.rejects(writeReply(async()=>({text:'你现在在哪个学校上学？'}),ctx,plan),/未经规划/)
})
test('earlier selected negative emotion keeps TEASE blocked after a later haha',()=>{
  const c=contact();c.learning.messages=[m('sad','contact','刚分手，真的很难过'),m('reaction','contact','哈哈哈哈')]
  const ctx=buildContext({contact:c,incoming:'哈哈哈哈',now})
  const plan=parsePlan(JSON.stringify({plan:{shouldReply:true,action:'TEASE',goal:'调侃',relationshipIntensity:.2},learning:{enabled:false}}),ctx)
  assert.equal(plan.action,'EMPATHY');assert.equal(plan.relationshipIntensity,0)
})
test('failed media preserves the earlier direct-question goal instead of answering the unknown picture',()=>{
  const c=contact();c.learning.messages=[m('question','contact','你觉得旅游几月份合适？'),{...m('img','contact','[图片]'),type:'image'}]
  const ctx=buildContext({contact:c,incoming:'[图片]',now,media:{interpretation:{messageId:'img',originalText:'[图片]',type:'image',understandingStatus:'failed'}}})
  const plan=parsePlan(JSON.stringify({plan:{shouldReply:true,action:'ANSWER',goal:'解释图片',allowQuestion:false},learning:{enabled:false}}),ctx)
  assert.equal(plan.focusMessageId,'question');assert.match(plan.goal,/旅游几月份/);assert.match(plan.goal,/图片未知/)
})
