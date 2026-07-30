const { fetchMyProfile, guideProfileSetupOnce } = require('../../utils/user.js')

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    roles: [],
    isAdmin: false
  },
  goToEdit: function () {
    wx.navigateTo({ url: '/pages/editprofile/editprofile' })
  },
  goToMySublets: function () {
    wx.navigateTo({ url: '/pages/mysublets/mysublets' })
  },
  goToMyTasks: function () {
    wx.navigateTo({ url: '/pages/mytasks/mytasks' })
  },

  // 编辑资料返回时会再走一次 onShow，改动就刷新出来了
  onShow: function () {
    fetchMyProfile().then(profile => {
      const roles = profile.roles
      this.setData({
        roles: roles,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        isAdmin: roles.includes('food_admin') || roles.includes('market_admin') || roles.includes('super_admin')
      })
      guideProfileSetupOnce(profile)
    }).catch(err => {
      console.error('加载个人资料失败：', err)
    })
  },

  goToMyItems: function () {
    wx.navigateTo({ url: '/pages/myitems/myitems' })
  },
  goToMyOrders: function () {
    wx.navigateTo({ url: '/pages/myorders/myorders' })  // 我的订单(已有)
  }
})
