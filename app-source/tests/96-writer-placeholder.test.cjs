const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { createSeedSelfProfile } = require('../electron/social-brain/self-profile.cjs')

const now = new Date('2026-10-15T12:00:00+08:00')
function setup(incoming = '今天吃了肠粉') {
  const contact = { id: 'placeholder-test', name: 'xx', profile: { chatMode: 'friendship', relationship: '刚认识' }, learning: { messages: [{ id: 'latest', role: 'contact', text: incoming, at: now.toISOString() }] } }
  const context = buildContext({ contact, incoming, selfProfile: createSeedSelfProfile({ now }), now })
  const plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '自然接话', allowQuestion: false, allowSelfDisclosure: false, selfDisclosureKeys: [] }, learning: { enabled: false } }), context)
  return { context, plan }
}

test('real Writer rejects the observed XX school output and corrects once under the same disclosure plan', async () => {
  const { context, plan } = setup(), calls = []
  const result = await writeReply(async (messages, options) => {
    calls.push({ messages, options })
    return { text: calls.length === 1 ? '不好意思呀刚看到消息，我在广州的XX读研哦' : '肠粉确实好吃哈哈', usage: { prompt: 10, completion: 5, total: 15 } }
  }, context, plan)
  assert.equal(calls.length, 2)
  assert.equal(result.text, '肠粉确实好吃哈哈')
  assert.equal(result.correctionAttempts, 1)
  assert.deepEqual(result.result.usage, { prompt: 20, completion: 10, total: 30 })
  const first = JSON.parse(calls[0].messages[1].content), second = JSON.parse(calls[1].messages[1].content)
  assert.deepEqual(second, first)
  assert.equal(first.plan.allowSelfDisclosure, false)
  assert.deepEqual(first.context.approvedSelfDisclosure, [])
  assert.deepEqual(JSON.parse(calls[1].messages[2].content).sameApprovedSelfDisclosure, [])
  assert.match(calls[1].messages[2].content, /未填写占位符/)
  assert.match(calls[1].messages[0].content, /不猜真实学校来替换/)
})

test('repeated placeholder outputs fail closed after exactly two Writer calls', async () => {
  const { context, plan } = setup()
  let calls = 0
  await assert.rejects(writeReply(async () => {
    calls++
    return { text: calls === 1 ? '我在广州的XX读研哦' : '我在XX大学读研' }
  }, context, plan), error => error.code === 'WRITER_VALIDATION_FAILED' && /未填写占位符/.test(error.message))
  assert.equal(calls, 2)
})

for (const text of ['我叫某某', '我的学校是XX', '我在xxx大学读书', '我在“XX”大学读研', '学校：XX', 'XX大学读研', '我就读于[学校]', '我来自某某', '我的公司是待填写']) {
  test(`Writer blocks unfilled personal fact: ${text}`, async () => {
    const { context, plan } = setup()
    let calls = 0
    await assert.rejects(writeReply(async () => { calls++; return { text } }, context, plan), /未填写占位符/)
    assert.equal(calls, 2)
  })
}

for (const text of [
  '刚才那个XX是我说错了',
  '刚才的XX写错了，不好意思哈哈',
  '“XX”这个说法是我刚才写错了',
  'xx，你这表情哈哈',
  '你说的xx挺有意思',
  'XXL和XL差一号',
  '我在XXL和XL之间纠结',
  '数学里XX可以看作两个X相乘',
  '我在算XX的值',
]) {
  test(`Writer permits ordinary or corrective XX context: ${text}`, async () => {
    const { context, plan } = setup('xx是什么鬼')
    let calls = 0
    const result = await writeReply(async () => { calls++; return { text } }, context, plan)
    assert.equal(result.text, text)
    assert.equal(calls, 1)
  })
}

test('placeholder guard also protects non-adaptive legacy Writer replies', async () => {
  const { context, plan } = setup()
  context.constraints.adaptiveProfileEnabled = false
  let calls = 0
  const result = await writeReply(async () => { calls++; return { text: calls === 1 ? '我在广州的XX读研' : '刚才那句说错了' } }, context, plan)
  assert.equal(calls, 2)
  assert.equal(result.text, '刚才那句说错了')
})
