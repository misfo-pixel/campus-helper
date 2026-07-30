Page({
  data: {
    items: []
  },

  onShow: function () {
    // 先拿自己的 openid，再查自己发的
    wx.cloud.callFunction({ name: 'login' }).then(res => {
      if (!res.result.success) return
      const myOpenid = res.result.openid
      const db = wx.cloud.database()
      db.collection('secondhand_items')
        .where({ _openid: myOpenid })   // 只查我发的
        .orderBy('created_at', 'desc')
        .get()
        .then(res => {
          console.log('我发布的闲置：', res.data)
          this.setData({ items: res.data })
        })
        .catch(err => console.error('加载失败：', err))
    })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/itemdetail/itemdetail?id=' + id })
  }
})