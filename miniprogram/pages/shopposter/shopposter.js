// 海报（店长）。从「我的小店」的场次卡片点「海报」进来，带场次 id。
//
// 打开就排一张长图：配色从 logo 取色，风格三选一（杂志 / 黑板 / 手账），
// 挑的风格存在店铺上（poster_style），转发卡片和店铺点单页跟着用。
// 菜全部列出来，排版在手机上做，几秒就好。

const { md, weekday, ownerTitle, cardData, longData } = require('../../utils/group.js')
const { showPoster } = require('../../utils/groupCover.js')

const STYLES = [
  { key: 'magazine', label: '杂志' },
  { key: 'chalkboard', label: '黑板' },
  { key: 'scrapbook', label: '手账' }
]

Page({
  data: {
    loading: true,
    session: null,
    dayText: '',
    styles: STYLES,
    style: 'magazine',
    longPath: '',
    drawing: false
  },

  onLoad: function (options) {
    this.sessionId = options.id
  },

  // 从小店设置改完广告语、换了 logo 回来，都重新排一遍
  onShow: function () {
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({ name: 'shopBrowse', data: { action: 'detail', sessionId: this.sessionId } }).then(res => {
      const r = (res && res.result) || {}
      const s = (r.sessions || []).find(x => x._id === this.sessionId)
      if (!r.success || !s) {
        this.setData({ loading: false })
        wx.showModal({ title: '这一场已截单', showCancel: false, success: () => wx.navigateBack() })
        return
      }
      this.shop = r.shop
      this.items = r.items || []
      this.session = s
      this.setData({
        loading: false,
        session: s,
        dayText: md(s.date) + ' ' + weekday(s.date),
        style: r.shop.poster_style || 'magazine'
      })
      this.draw()
    }).catch(err => {
      console.error('读取海报信息失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 排长图预览，顺带把转发卡片也画好
  draw: function () {
    const gs = this.selectComponent('#gs')
    const shop = Object.assign({}, this.shop, { poster_style: this.data.style })
    this.setData({ drawing: true })
    const qr = this.qr !== undefined
      ? Promise.resolve(this.qr)
      : wx.cloud.callFunction({ name: 'getMiniCode', data: { sessionId: this.sessionId } })
        .then(res => ((res && res.result) || {}).fileID || '')
        .catch(() => '')
        .then(id => { this.qr = id; return id })
    Promise.all([gs.themeFor(shop), qr]).then(([theme, qrId]) => {
      return gs.long(longData(shop, this.session, this.items, theme, qrId)).then(path => {
        this.setData({ longPath: path, drawing: false })
        return gs.card(cardData(shop, this.session, this.items, theme))
      }).then(card => { this.cardPath = card })
    }).catch(err => {
      console.error('排海报失败：', err)
      this.setData({ drawing: false })
    })
  },

  pickStyle: function (e) {
    const style = e.currentTarget.dataset.style
    if (style === this.data.style || this.data.drawing) return
    this.setData({ style: style }, () => this.draw())
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'setPosterStyle', style: style } })
      .catch(err => console.warn('保存海报风格失败：', err))
  },

  save: function () {
    if (this.data.longPath) showPoster(this.data.longPath)
  },

  previewLong: function () {
    this.save()
  },

  // 店长转发：标题用广告语，主图是按这家店配色画的卡片
  onShareAppMessage: function () {
    const s = this.session
    if (!s) return { title: '一起拼团 · 满单成团，送到学校', path: '/pages/shoplist/shoplist' }
    const share = {
      title: ownerTitle(this.shop, s),
      path: '/pages/shopdetail/shopdetail?id=' + this.shop._id + '&s=' + s._id + '&from=share'
    }
    if (this.cardPath) share.imageUrl = this.cardPath
    return share
  }
})
