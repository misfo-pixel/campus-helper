// 活动详情。首页横幅点进来，内容全在 config.js 的 HOME_BANNERS（按 id 找），换活动不用改这一页。
// 不只找期内的：群里转出去的链接过期后再点开，要显示「活动已结束」而不是空白
const { HOME_BANNERS } = require('../../config.js')
const { today } = require('../../utils/date.js')
const { loadDisplayFont } = require('../../utils/fonts.js')
const { t, f } = require('../../i18n/index.js')

Page({
  data: {
    ev: null,
    ended: false,
    notFound: false
  },

  onLoad: function (options) {
    loadDisplayFont()
    const b = HOME_BANNERS.filter(x => x.id && x.id === options.id)[0]
    if (!b) {
      this.setData({ notFound: true })
      return
    }
    const fill = s => f(s, b.wechat || '')
    this.banner = b
    this.setData({
      ended: today() > b.until,
      ev: {
        title: t(b.title),
        amount: b.amount,
        unit: t(b.unit || ''),
        proof: t(b.proof || ''),
        image: b.image,
        steps: (b.steps || []).map(fill),
        notes: (b.notes || []).map(fill),
        wechat: b.wechat || '',
        cta: b.cta ? { text: t(b.cta.text), url: b.cta.url } : null
      }
    })
    wx.setNavigationBarTitle({ title: t(b.title) })
  },

  copyWechat: function () {
    const wechat = this.data.ev && this.data.ev.wechat
    if (!wechat) return
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: t('微信号已复制'), icon: 'success' })
    })
  },

  goCta: function () {
    const cta = this.data.ev && this.data.ev.cta
    if (cta) wx.navigateTo({ url: cta.url })
  },

  onShareAppMessage: function () {
    const b = this.banner
    if (!b) return { title: t('明尼助手'), path: '/pages/home/home' }
    return {
      title: t(b.share || b.title),
      path: '/pages/event/event?id=' + b.id,
      imageUrl: b.image
    }
  }
})
