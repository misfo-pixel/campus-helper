// 首页横幅和它的活动元素。都跟着 config.js 的 HOME_BANNERS 走，横幅到期下架，
// 二手转发封面上的贴纸、长图海报上的活动条也一起消失，不用另外记得去关。

const { HOME_BANNERS } = require('../config.js')
const { today } = require('./date.js')
const { f } = require('../i18n/index.js')

// 期内的第一条。按手机本地日期算，和 autoExpire 一个口径（见 utils/date.js）
function currentBanner() {
  const d = today()
  return HOME_BANNERS.filter(b => b.from <= d && d <= b.until)[0] || null
}

// 当前横幅填了 promo 才有，返回 { banner, sticker, how }。how 已经把客服微信号填进去了
function currentPromo() {
  const b = currentBanner()
  if (!b || !b.promo) return null
  return {
    banner: b.image,
    sticker: b.promo.sticker || '',
    how: b.promo.how ? f(b.promo.how, b.wechat || '') : ''
  }
}

module.exports = {
  currentBanner: currentBanner,
  currentPromo: currentPromo
}
