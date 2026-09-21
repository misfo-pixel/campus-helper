// 校外服务列表。只显示审核通过、且没打烊的店。
const STATUS_TEXT = { open: '营业中', paused: '已打烊' }

Page({
  data: {
    loading: true,
    shops: []
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'shopBrowse', data: { action: 'list' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }
      const shops = (r.shops || []).map(s => Object.assign({}, s, {
        statusText: STATUS_TEXT[s.status] || ''
      }))
      this.setData({ shops: shops, loading: false })
      if (done) done()
    }).catch(err => {
      console.error('读取店铺列表失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  goToShop: function (e) {
    wx.navigateTo({ url: '/pages/shopdetail/shopdetail?id=' + e.currentTarget.dataset.id })
  },

  goToMyOrders: function () {
    wx.navigateTo({ url: '/pages/myshoporders/myshoporders' })
  }
})
