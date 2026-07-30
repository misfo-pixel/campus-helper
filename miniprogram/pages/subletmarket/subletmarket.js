Page({
  data: {
    items: []
  },

  onShow: function () {
    const db = wx.cloud.database()
    db.collection('sublet_items')
      .where({ status: 'on_sale' })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        console.log('在租房源：', res.data)
        this.setData({ items: res.data })
      })
      .catch(err => {
        console.error('加载失败：', err)
      })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/subletdetail/subletdetail?id=' + id })
  },

  goToPublish: function () {
    wx.navigateTo({ url: '/pages/subletpublish/subletpublish' })
  }
})