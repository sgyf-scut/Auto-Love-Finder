// A deliberate abstention is not a transport/parser failure. Human decisions
// are never retried or overwritten. Historic failed UNKNOWN records are eligible.
function retryableClassification(comment) {
 const c = comment?.classification
 return !!c && !c.reviewedByUser && c.intent === 'UNKNOWN' &&
   (c.needsRetry === true || /模型分类失败|超出调用预算|解析失败|请求失败/.test(c.reason || ''))
}
module.exports = { retryableClassification }
