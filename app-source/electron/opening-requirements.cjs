const MAX_OPENING_REQUIREMENTS = 2000
function normalizeOpeningRequirements(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_OPENING_REQUIREMENTS) : ''
}
function openingRequirementsOf(state = {}) { return normalizeOpeningRequirements(state.settings?.openingRequirements) }
function openingPolicyOf(state = {}) {
  const settings = state.settings || {}
  return { mode: settings.openingMode === 'fixed' ? 'fixed' : 'ai', requirements: openingRequirementsOf(state),
    fixedText: typeof settings.fixedOpeningText === 'string' && settings.fixedOpeningText.length <= 80 ? settings.fixedOpeningText : '' }
}
function validateFixedOpening(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 80) throw new Error('固定首句请填写1～80字，内容将原样使用')
  return text
}
module.exports = { MAX_OPENING_REQUIREMENTS, normalizeOpeningRequirements, openingRequirementsOf, openingPolicyOf, validateFixedOpening }
