// 参团成功。下单页提交后 redirect 过来，参数是刚下完单那一刻的进度。
//
// 这一页就是为了转发：刚下完单的人最想成团，这时候喊人最有动力。
// 转发卡片用第一人称（「我拼了 XX，再来 3 位就开团」），群里看着像朋友在叫，不像广告。
// 微信不允许「转发后才能…」「转发得奖励」这类诱导分享，这里只放一个按钮，不给任何奖励。

const { md, weekday, progress, shareTitle, cardData, longData } = require('../../utils/group.js')
const { showPoster } = require('../../utils/groupCover.js')
const { t, f } = require('../../i18n/index.js')

Page({
  data: {
    name: '',
    p: null,
    cutText: '',
    pickText: '',
    posterBusy: false
  },

  onLoad: function (q) {
    const d = k => decodeURIComponent(q[k] || '')
    this.info = {
      shop: d('shop'),
      name: d('name'),
      session: d('s'),
      date: d('date'),
      count: Number(d('count')) || 0,
      min_orders: Number(d('min')) || 0,
      forced: d('forced') === '1'
    }
    const cut = d('cut')
    const p = progress(this.info, true)
    this.setData({
      name: this.info.name,
      p: p,
      headline: p.open ? t('下单成功') : (p.forced ? p.text : (p.formed ? t('已成团') : f('再来 {0} 位就开团', p.gap))),
      countText: p.open ? '' : f('{0} / {1} 单', this.info.count, this.info.min_orders),
      cutText: cut ? f('{0} {1} {2} 截单', md(cut), weekday(cut.slice(0, 10)), cut.slice(11, 16)) : '',
      pickText: md(this.info.date) + ' ' + weekday(this.info.date) + ' ' + d('at') + (d('point') ? ' · ' + d('point') : '')
    })
    this.loadCover()
  },

  // 转发卡片和海报要店铺、商品和这一场的背景图，进页面先取回来，把卡片画好备着
  loadCover: function () {
    const i = this.info
    wx.cloud.callFunction({ name: 'shopBrowse', data: { action: 'detail', shopId: i.shop } }).then(res => {
      const r = (res && res.result) || {}
      const s = (r.sessions || []).find(x => x._id === i.session)
      if (!r.success || !s) return
      const gs = this.selectComponent('#gs')
      return gs.themeFor(r.shop).then(theme => {
        this.cover = { shop: r.shop, session: s, items: r.items, theme: theme }
        return gs.card(cardData(r.shop, s, r.items, theme))
      }).then(p => { this.cardPath = p })
    }).catch(err => console.warn('转发卡片没画出来：', err))
  },

  makePoster: function () {
    if (!this.cover || this.data.posterBusy) {
      if (!this.cover) wx.showToast({ title: t('还在准备，稍等再点'), icon: 'none' })
      return
    }
    this.setData({ posterBusy: true })
    wx.showLoading({ title: t('生成中…'), mask: true })
    wx.cloud.callFunction({ name: 'getMiniCode', data: { sessionId: this.info.session } })
      .then(res => ((res && res.result) || {}).fileID || '')
      .catch(() => '')
      .then(qr => {
        const c = this.cover
        return this.selectComponent('#gs').long(longData(c.shop, c.session, c.items, c.theme, qr))
      })
      .then(path => {
        wx.hideLoading()
        showPoster(path)
      })
      .catch(err => {
        console.error('生成海报失败：', err)
        wx.hideLoading()
        wx.showToast({ title: t('生成失败，请重试'), icon: 'none' })
      })
      .then(() => this.setData({ posterBusy: false }))
  },

  goToOrders: function () {
    wx.redirectTo({ url: '/pages/myshoporders/myshoporders' })
  },

  onShareAppMessage: function () {
    const i = this.info || {}
    const share = {
      title: shareTitle(i.name, i, true),
      path: '/pages/shopdetail/shopdetail?id=' + i.shop + '&s=' + i.session + '&from=share'
    }
    if (this.cardPath) share.imageUrl = this.cardPath
    return share
  }
})
