Page({
  data: {
    items: []
  },

  onShow: function () {
    wx.cloud.callFunction({ name: 'login' }).then(res => {
      if (!res.result.success) return
      const myOpenid = res.result.openid
      const db = wx.cloud.database()
      db.collection('sublet_items')
        .where({ _openid: myOpenid })
        .orderBy('created_at', 'desc')
        .get()
        .then(res => {
          this.setData({ items: res.data })
        })
        .catch(err => console.error('加载失败：', err))
    })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/subletdetail/subletdetail?id=' + id })
  }
})