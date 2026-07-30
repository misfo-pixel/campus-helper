Page({
  data: {
    nickname: '',
    wechat: ''
  },

  onLoad: function () {
    // 读取当前用户已有信息，预填
    wx.cloud.callFunction({ name: 'login' }).then(res => {
      if (res.result.success) {
        // login 返回里没有 nickname/wechat，需要查一下 users 表
        const db = wx.cloud.database()
        db.collection('users').where({ openid: res.result.openid }).get().then(u => {
          if (u.data.length > 0) {
            this.setData({
              nickname: u.data[0].nickname === '匿名用户' ? '' : u.data[0].nickname,
              wechat: u.data[0].wechat || ''
            })
          }
        })
      }
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  save: function () {
    wx.cloud.callFunction({
      name: 'updateUserInfo',
      data: {
        nickname: this.data.nickname,
        wechat: this.data.wechat
      }
    }).then(res => {
      if (res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 1000)
      } else {
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    })
  }
})