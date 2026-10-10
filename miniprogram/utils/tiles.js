// 首页和发布页的入口格（样式在 app.wxss 的 .tile）。
//
// 入口数跟着 config.js 的模块开关变，单数时最后一个铺满一行，
// 不然右下角会空出一块。「新」小标带截止日期，到期自己消失，不用记着回来删。
const { today } = require('./date.js')

function layoutTiles(list) {
  const d = today()
  const shown = list.filter(t => t.enabled !== false)
  return shown.map((t, i) => Object.assign({}, t, {
    wide: shown.length % 2 === 1 && i === shown.length - 1,
    sticker: t.sticker && (!t.stickerUntil || d <= t.stickerUntil) ? t.sticker : ''
  }))
}

module.exports = { layoutTiles: layoutTiles }
