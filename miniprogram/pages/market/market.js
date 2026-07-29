// pages/market/market.js
Page({
  data: {
    items: []
  },

  onShow: function () {
    this.loadItems()
  },

  loadItems: function () {
    const db = wx.cloud.database()
    // 只查在售的（status 为 on_sale），按发布时间倒序（最新的在前）
    db.collection('secondhand_items')
      .where({ status: 'on_sale' })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        console.log('在售商品：', res.data)
        this.setData({ items: res.data })
      })
      .catch(err => {
        console.error('加载商品失败：', err)
      })
  },

  // 点商品去详情页
  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/itemdetail/itemdetail?id=' + id })
  },

  // 去发布页
  goToPublish: function () {
    wx.navigateTo({ url: '/pages/publish/publish' })
  }
})