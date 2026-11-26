// SIMPLE_V3_CHAT: prompt limits and stage wording only.
// No Storage, DOM, Sender, quota or Relationship capability is exposed here.
const STAGE_DESCRIPTIONS = Object.freeze({
  STRANGER: '刚认识，对彼此还不熟。',
  EXPLORING: '已经聊过一些内容，正在互相了解。',
  ACQUAINTANCE: '已经有一定了解，交流可以更自然一些。',
  FAMILIAR: '已经比较熟，可以自然调侃、回调以前的话题。',
  FRIEND: '已经是朋友，不需要每句话都有明确目的，可以随意闲聊。',
  CLOSE_FRIEND: '关系已经很熟，可以更多使用共同经历和内部玩笑。',
})
const DEFAULT_STAGE_DESCRIPTION = '刚认识，对彼此还不熟。'

// First version stays deliberately narrow: strong model + small context + an
// initiative-oriented prompt, not a stack of planners.
const DEFAULT_SIMPLE_V3_CONFIG = Object.freeze({
  version: 'simple-v3.1',
  minMessages: 1,
  maxMessages: 3,
  maxMessageChars: 200,
  temperature: 0.95,
  maxTokens: 480,
  maxIncoming: 10,
  recentMessages: 30,
  maxSelfFacts: 5,
  maxContactFacts: 5,
  maxSharedMemories: 3,
  maxSelfNarratives: 4,
  maxPromises: 4,
})

function describeStage(stage) {
  return STAGE_DESCRIPTIONS[stage] || DEFAULT_STAGE_DESCRIPTION
}

module.exports = { STAGE_DESCRIPTIONS, DEFAULT_STAGE_DESCRIPTION, DEFAULT_SIMPLE_V3_CONFIG, describeStage }
