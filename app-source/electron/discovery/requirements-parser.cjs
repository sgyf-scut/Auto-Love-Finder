const { normalizeDiscoveryConfig } = require('./search-topics.cjs')

async function parseRequirements(ai, text, current = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('请填写2000字以内的交友对象要求')
  if (!ai?.inquiryCompletion) throw new Error('请先配置可用的AI模型')
  const result = await ai.inquiryCompletion([
    { role: 'system', content: '你只解析用户的交友对象筛选要求，不能执行关注、发送或修改设置。只输出JSON：{targetGender:"female"|"any",requireFollowerLimit:boolean,followerLimit:number,requireAgeRange:boolean,ageMin:number,ageMax:number,preferLowerComments:boolean,preferLowReplies:boolean,includeReplies:boolean,keywords:string[],unsupported:string[]}。followerLimit是排他的上限，“粉丝少于150”填150，“不超过150”填151。没有粉丝要求时requireFollowerLimit=false，没有性别要求时any。只有明确的成年年龄范围才设置requireAgeRange=true并填写含边界的ageMin/ageMax，没有年龄要求时false、20、30；模糊年龄或未成年范围列入unsupported，不虚构。年龄性别仅依据公开自述或人工确认，不能根据头像照片推断。评论往下/靠后为preferLowerComments，少回复/无人回复为preferLowReplies，楼中楼/别人评论下为includeReplies。视频标签和搜索关键词由用户在独立输入框手动设置，keywords固定输出[]，不要推测、生成或改写视频搜索内容；用户在此提到视频主题时，在unsupported提示应填入独立的视频标签或搜索关键词框。地区、职业或其他当前schema不支持的条件逐条写入unsupported，不猜测或声称可以筛选，不省略限制。' },
    { role: 'user', content: text.trim() },
  ], { temperature: 0.1, maxTokens: 700, structuredJson: true })
  let value
  try { value = JSON.parse(result.text) } catch { throw new Error('AI未返回有效的筛选JSON，请重试') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['female', 'any'].includes(value.targetGender)
    || !['requireFollowerLimit', 'preferLowerComments', 'preferLowReplies', 'includeReplies'].every(k => typeof value[k] === 'boolean')
    || !Array.isArray(value.keywords) || !value.keywords.every(k => typeof k === 'string') || !Array.isArray(value.unsupported) || !value.unsupported.every(k => typeof k === 'string')
    || typeof value.requireAgeRange !== 'boolean'
    || (value.requireAgeRange && (!Number.isSafeInteger(value.ageMin) || !Number.isSafeInteger(value.ageMax) || value.ageMin < 18 || value.ageMax > 100 || value.ageMin > value.ageMax))
    || (value.requireFollowerLimit && (!Number.isSafeInteger(value.followerLimit) || value.followerLimit < 1 || value.followerLimit > 100000))) throw new Error('AI解析的条件不完整或越界，请重试或手动修改')
  const config = normalizeDiscoveryConfig({ ...normalizeDiscoveryConfig(current), requirementsText: text.trim(), targetGender: value.targetGender,
    requireFollowerLimit: value.requireFollowerLimit, followerLimit: value.requireFollowerLimit ? value.followerLimit : current.followerLimit,
    requireAgeRange: value.requireAgeRange === true, ageMin: value.requireAgeRange ? value.ageMin : current.ageMin, ageMax: value.requireAgeRange ? value.ageMax : current.ageMax,
    preferLowerComments: value.preferLowerComments, preferLowReplies: value.preferLowReplies, includeReplies: value.includeReplies })
  return { ok: true, config, unsupported: value.unsupported.map(t => t.slice(0, 200)).slice(0, 10), model: result.model }
}
module.exports = { parseRequirements }
