Page({
  data: {
    items: []
  },

  onShow: function () {
    const db = wx.cloud.database()
    db.collection('task_items')
      .where({ status: 'open' })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        console.log('招募中的委托：', res.data)
        this.setData({ items: res.data })
      })
      .catch(err => {
        console.error('加载失败：', err)
      })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/taskdetail/taskdetail?id=' + id })
  },

  goToPublish: function () {
    wx.navigateTo({ url: '/pages/taskpublish/taskpublish' })
  }
})