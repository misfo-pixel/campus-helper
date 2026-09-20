// 汇总清单：一趟活的全部信息。
//
// 上半是取货清单——直接念给店长报单，不用一单一单翻。
// 下半是交付清单，按服务地点分组：到了点上，照着名字把东西发给来取的人。
//
// 这两张表是老饭搭子汇总页的核心，批次配送要的正是它，直接迁过来。
// （老页面 pages/summary 已删除，实现在 git 历史里。）

Page({
  data: {
    loading: true,
    batchKey: '',
    shopId: '',
    shopName: '',
    batchLabel: '',
    deliverTime: '',
    pickup: [],
    points: [],
    allPicked: false,
    remaining: 0
  },

  onLoad: function (options) {
    this.setData({
      batchKey: decodeURIComponent(options.batch || ''),
      shopId: options.shop || ''
    })
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'teamOrders',
      data: { action: 'manifest', batch_key: this.data.batchKey, shop_id: this.data.shopId }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      const points = r.points || []
      let waiting = 0
      let remaining = 0
      points.forEach(b => b.orders.forEach(o => {
        if (o.delivery_status === 'waiting') waiting++
        if (o.delivery_status !== 'delivered') remaining++
      }))

      this.setData({
        loading: false,
        shopName: r.shopName || '',
        batchLabel: r.batchLabel || '',
        deliverTime: r.deliverTime || '',
        pickup: r.pickup || [],
        points: points,
        allPicked: waiting === 0,
        remaining: remaining
      })
    }).catch(err => {
      console.error('读取清单失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 到店取到货了：整批一次性标记，同时店长那边自动变成「配送中」
  markPicked: function () {
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'teamOrders',
      data: { action: 'markPicked', batch_key: this.data.batchKey, shop_id: this.data.shopId }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已标记取货', icon: 'success' })
        this.load()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('标记取货失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    })
  },

  markDelivered: function (e) {
    const id = e.currentTarget.dataset.id
    wx.cloud.callFunction({
      name: 'teamOrders',
      data: { action: 'markDelivered', orderId: id }
    }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已送达', icon: 'success' })
        this.load()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    }).catch(err => {
      console.error('标记送达失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    })
  },

  copyWechat: function (e) {
    const wechat = e.currentTarget.dataset.wechat
    if (!wechat) return
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  }
})
