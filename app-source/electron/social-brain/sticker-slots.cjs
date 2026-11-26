// The user maintains these ten favorite positions in Douyin. Models choose
// semantic intent only; the application is the sole source of slot numbers.
const STICKER_SLOTS = Object.freeze({ TEASE: 1, LIKE: 2, HAPPY: 3, FLIRT: 4, SAD: 5, SURPRISED: 6, SPEECHLESS: 7, COMFORT: 8, ANNOYED: 9, GOODNIGHT: 10 })
const STICKER_INTENTS = Object.freeze(['NONE', ...Object.keys(STICKER_SLOTS)])
function stickerSlot(intent) { return Object.hasOwn(STICKER_SLOTS, intent) ? STICKER_SLOTS[intent] : null }
module.exports = { STICKER_SLOTS, STICKER_INTENTS, stickerSlot }
