// 我的服务订单（买家侧）。
// 待确认的单会把商家收款方式显示出来，方便买家去转账。

const STATUS_TEXT = {
  pending: '待商家确认',
  accepted: '备餐中',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

// 待确认的单要提示去付款，其余状态给一句状态说明
const STATUS_HINT = {
  pending: '请按下面的方式付款给商家，商家确认收款后会接单',
  accepted: '商家已接单，正在备餐',
  delivering: '商家正在配送',
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
      this.setData({ orders: orders, loading: false })
      if (done) done()
    }).catch(err => {
      console.error('读取订单失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
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
      content: '确定取消这笔订单吗？如果你已经付过款，取消后需要自己联系商家退款。',
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
