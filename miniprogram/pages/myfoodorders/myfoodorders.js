// 我的服务订单（买家侧）。
// 订单展示店长微信；店长自己开了收款展示位的话，待确认的单里还会显示
// 他填的收款方式和收款码。平台只原样展示，不经手资金、不验证账户归属。

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

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
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

  // 点开大图，用户可以长按保存收款码
  previewQr: function (e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
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
