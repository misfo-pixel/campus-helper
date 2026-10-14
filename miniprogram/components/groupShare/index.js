// 拼团和二手的转发卡片、长图海报，还有从 logo / 照片里取色，都画在这个组件自己的画布上。
// 页面里放一个 <group-share id="gs" />，然后：
//   this.selectComponent('#gs').themeFor(shop)   这家店的配色（从 logo 取色）
//   .card(d) / .long(d)                          出图，数据格式见 utils/groupCover.js
//   .themeFromPhotos([fileID...], style)          二手：从头像和商品照片取色
//   .promoCover(本地图, 本地贴纸)                   二手转发封面贴上活动贴纸（见 utils/share.js 的 withPromo）
//
// 只用来贴活动贴纸的页面写 <group-share id="gs" no-font />：贴纸是图，用不上展示字体，
// 二手详情页人人都会打开，不该每次都去下一遍字体
//
// 同一块画布同时只能画一张，连着叫的话排队，不然后一张会把前一张画了一半的冲掉。

const { renderCard, renderLong, renderPromoCover } = require('../../utils/groupCover.js')
const { withFont } = require('../../utils/fonts.js')
const { getCanvasNode, toLocalPath, loadImage } = require('../../utils/poster.js')
const { fromColors, toHex, FALLBACK } = require('../../utils/theme.js')

// 画之前等黄油体下完，最多等这么久就先用系统字体画。
// 卡片常在点转发时现画（微信只等 3 秒），等得短；海报是专门点按钮生成的，可以多等一会儿
const CARD_FONT_WAIT = 1200
const LONG_FONT_WAIT = 4000
const PICK = 48

// 同一个 logo、同一组照片取过色就记住，翻页、反复转发不用每次重算
const themeCache = {}

// 把图缩成 48×48 画出来，数每种颜色出现的次数（每个通道粗分成 8 档），取最常见的几种。
// 太白、太黑、太灰的不要——那多半是底色和阴影，不是这家店的颜色
function dominantColors(ctx, img) {
  ctx.clearRect(0, 0, PICK, PICK)
  ctx.drawImage(img, 0, 0, PICK, PICK)
  const data = ctx.getImageData(0, 0, PICK, PICK).data
  const buckets = {}
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max > 240 && min > 225) continue
    if (max < 30) continue
    if (max - min < 18) continue
    const key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5)
    const bk = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 })
    bk.n++
    bk.r += r
    bk.g += g
    bk.b += b
  }
  return Object.keys(buckets)
    .map(k => buckets[k])
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map(bk => toHex([bk.r / bk.n, bk.g / bk.n, bk.b / bk.n]))
}

Component({
  properties: {
    noFont: Boolean
  },

  lifetimes: {
    // 页面一打开就开始下字体，等到点转发时多半已经好了
    attached: function () {
      if (!this.data.noFont) withFont(0)
    }
  },

  methods: {
    queue: function (job) {
      const run = () => job()
      this.pending = (this.pending || Promise.resolve()).then(run, run)
      return this.pending
    },

    card: function (d) {
      return this.queue(() => withFont(CARD_FONT_WAIT).then(() => renderCard('#gsCard', this, d)))
    },

    long: function (d) {
      return this.queue(() => withFont(LONG_FONT_WAIT).then(() => renderLong('#gsLong', this, d)))
    },

    promoCover: function (src, sticker) {
      return this.queue(() => renderPromoCover('#gsCard', this, src, sticker))
    },

    // 几张图里的主色，合在一起返回。哪张下载失败就跳过
    colorsOf: function (fileIDs) {
      return this.queue(() => getCanvasNode('#gsPick', this).then(canvas => {
        canvas.width = PICK
        canvas.height = PICK
        const ctx = canvas.getContext('2d')
        return Promise.all((fileIDs || []).filter(Boolean).slice(0, 5).map(id => toLocalPath(id).then(p => loadImage(canvas, p))))
          .then(imgs => {
            const out = []
            imgs.filter(Boolean).forEach(img => {
              try {
                dominantColors(ctx, img).forEach(c => { if (out.indexOf(c) === -1) out.push(c) })
              } catch (e) {
                console.warn('取色失败：', e)
              }
            })
            return out
          })
      })).catch(() => [])
    },

    // 店铺的配色：从 logo 取色现算，风格用店长在海报页挑的（poster_style）；没有 logo 就用兜底配色
    themeFor: function (shop) {
      const s = shop || {}
      const style = s.poster_style || 'magazine'
      const key = 'logo:' + (s.logo || '') + ':' + style
      if (themeCache[key]) return Promise.resolve(themeCache[key])
      if (!s.logo) return Promise.resolve(Object.assign({}, fromColors(['#d2462c'], style) || FALLBACK))
      return this.colorsOf([s.logo]).then(colors => {
        const t = fromColors(colors, style) || FALLBACK
        themeCache[key] = t
        return t
      })
    },

    // 二手：从头像和商品照片取色，用手账风格——卖闲置更像是自己的小摊
    themeFromPhotos: function (fileIDs) {
      const key = 'photos:' + (fileIDs || []).join('|')
      if (themeCache[key]) return Promise.resolve(themeCache[key])
      return this.colorsOf(fileIDs).then(colors => {
        const t = fromColors(colors, 'scrapbook') || Object.assign({}, FALLBACK, { style: 'scrapbook' })
        themeCache[key] = t
        return t
      })
    }
  }
})
