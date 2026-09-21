// 我的服务订单（买家侧）。
// 订单展示店长微信；店长自己开了收款展示位的话，待确认的单里还会显示
// 订单里还会回显买家自己下单时填的补充说明和配图。

const { formatTime } = require('../../utils/date.js')

const STATUS_TEXT = {
  pending: '待店长确认',
  accepted: '准备中',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

// 每个状态给一句说明。待确认的单只说「等店长联系」，不出现任何付款指引。
const STATUS_HINT = {
  pending: '已提交，等店长确认。店长会通过微信与你联系',
  accepted: '店长已接单，正在准备',
  delivering: '店长正在配送',
  completed: '订单已完成',
  cancelled: '订单已取消'
}

Page({
  data: {
    loading: true,
    orders: [],
    hasPending: false
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
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }
      const orders = (r.orders || []).map(o => Object.assign({}, o, {
        statusText: STATUS_TEXT[o.status] || o.status,
        statusHint: STATUS_HINT[o.status] || '',
        timeText: formatTime(o.created_at),
        shortId: (o._id || '').slice(-6).toUpperCase()
      }))
      this.setData({
        orders: orders,
        hasPending: orders.some(o => o.status === 'pending'),
        loading: false
      })
      if (done) done()
    }).catch(err => {
      console.error('读取订单失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  previewNoteImages: function (e) {
    const urls = e.currentTarget.dataset.urls || []
    wx.previewImage({ urls: urls, current: e.currentTarget.dataset.url })
  },

  copyText: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  },

  cancelOrder: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消订单',
      content: '确定取消这笔订单吗？如果你已经付过款，取消后需要自己联系店长退款。',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        wx.cloud.callFunction({
          name: 'buyerOrders',
          data: { action: 'cancel', orderId: id }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已取消', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '取消失败', icon: 'none' })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('取消订单失败：', err)
          wx.showToast({ title: '取消失败', icon: 'none' })
        })
      }
    })
  }
})
