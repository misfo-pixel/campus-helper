const app = getApp()

Page({
  data: {
    items: []
  },

  onShow: function () {
    // 复用 app.js 启动时的登录结果，不再打 login 云函数
    app.globalData.profileReady.then(profile => {
      if (!profile) return
      return wx.cloud.database().collection('task_items')
        .where({ _openid: profile.openid })
        .orderBy('created_at', 'desc')
        .get()
        .then(res => this.setData({ items: res.data }))
    }).catch(err => console.error('加载失败：', err))
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/taskdetail/taskdetail?id=' + id })
  }
})