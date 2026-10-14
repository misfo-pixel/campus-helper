// 我的订单（买家侧）。
// 订单展示店长手机，还会回显买家自己下单时填的补充说明和配图。
// 拼团中的单画进度条、能直接转发喊人；待确认的单写清楚几点前联系店长。
// 不出现任何付款指引（《店长责任告知书》第六节）。

const { formatTime } = require('../../utils/date.js')
const { md, weekday, progress, shareTitle, atText, cardData } = require('../../utils/group.js')
const { t, f } = require('../../i18n/index.js')

const STATUS_TEXT = {
  forming: '拼团中',
  confirming: '待确认',
  pending: '待确认',
  accepted: '已确认',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

Page({
  data: {
    loading: true,
    orders: []
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'buyerOrders', data: { action: 'list' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
        if (done) done()
        return
      }
      const orders = (r.orders || []).map(o => {
        const p = o.progress ? progress(o.progress, true) : null
        let hint = ''
        if (o.status === 'forming') hint = p ? p.text : ''
        else if (o.status === 'confirming') hint = f('已成团，{0} 前联系店长确认', atText(o.confirm_at, r.now))
        else if (o.status === 'accepted' || o.status === 'delivering') {
          hint = md(o.batch_date) + ' ' + weekday(o.batch_date) + ' ' + o.deliver_time + ' · ' + (o.pickup_point || o.pickup_info)
        }
        return Object.assign({}, o, {
          statusText: t(STATUS_TEXT[o.status] || o.status),
          hint: hint,
          p: p,
          timeText: formatTime(o.created_at),
          shortId: (o._id || '').slice(-6).toUpperCase()
        })
      })
      this.setData({ orders: orders, loading: false })
      if (done) done()
    }).catch(err => {
      console.error('读取订单失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
      if (done) done()
    })
  },

  // 拼团中的单上「喊人上车」
  onShareAppMessage: function (res) {
    const i = res && res.target && res.target.dataset ? res.target.dataset.index : undefined
    const o = i !== undefined ? this.data.orders[i] : null
    if (o && o.progress) {
      const s = Object.assign({ date: o.batch_date, points: [] }, o.progress)
      const share = {
        title: shareTitle(o.shop_name, s, true),
        path: '/pages/shopdetail/shopdetail?id=' + o.shop_id + '&s=' + o.session_id + '&from=share'
      }
      // 卡片主图现画：微信最多等 3 秒，画不完就用上面这份（默认截图）
      // 微信最多等 3 秒：从 logo 取色（取过的有缓存）再画，来不及就用上面这份
      const gs = this.selectComponent('#gs')
      const shop = { name: o.shop_name, slogan: o.shop_slogan, logo: o.shop_logo, poster_style: o.shop_poster_style }
      share.promise = gs.themeFor(shop)
        .then(theme => gs.card(cardData(shop, s, [], theme)))
        .then(p => Object.assign({}, share, { imageUrl: p }))
        .catch(() => share)
      return share
    }
    return { title: t('一起拼团 · 满单成团，送到学校'), path: '/pages/shoplist/shoplist' }
  },

  previewNoteImages: function (e) {
    const urls = e.currentTarget.dataset.urls || []
    wx.previewImage({ urls: urls, current: e.currentTarget.dataset.url })
  },

  callShop: function (e) {
    const phone = e.currentTarget.dataset.phone
    if (!phone) return
    wx.makePhoneCall({ phoneNumber: phone.replace(/[^\d+]/g, ''), fail: () => {} })
  },

  copyText: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: t('已复制'), icon: 'success' })
    })
  },

  // 成团后再取消，店长可能已经按单数备料了，记一次爽约（见 buyerOrders 的 cancel）
  cancelOrder: function (e) {
    const { id, status } = e.currentTarget.dataset
    wx.showModal({
      title: t('取消订单'),
      content: t(status === 'confirming' ? '已经成团了，取消会记一次爽约。' : '确定取消吗？'),
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: t('处理中'), mask: true })
        wx.cloud.callFunction({
          name: 'buyerOrders',
          data: { action: 'cancel', orderId: id }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: t('已取消'), icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: t(result.message || '取消失败'), icon: 'none' })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('取消订单失败：', err)
          wx.showToast({ title: t('取消失败'), icon: 'none' })
        })
      }
    })
  }
})
