const INTENT_LEVELS = { EXPLICIT_INVITATION: 3, SEEKING_FRIENDS: 2, CONTEXTUAL_INTEREST: 1 }
function intentFloor(value) { return Object.hasOwn(INTENT_LEVELS, value) ? value : 'CONTEXTUAL_INTEREST' }
function meetsIntent(intent, minimum) { return (INTENT_LEVELS[intent] || 0) >= INTENT_LEVELS[intentFloor(minimum)] }
function normalizeSampling(value = {}) {
  const size = (n, fallback) => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isFinite(Number(n)) ? Math.max(1, Math.min(200, Math.floor(Number(n)))) : fallback
  return { first: size(value?.first, 30), second: size(value?.second, 40), later: size(value?.later, 50), continueMinIntent: intentFloor(value?.continueMinIntent) }
}
module.exports = { INTENT_LEVELS, intentFloor, meetsIntent, normalizeSampling }
