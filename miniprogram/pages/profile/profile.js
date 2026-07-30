Page({
  data: {
    nickname: '',
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

  onShow: function () {
    // 拿当前用户信息
    wx.cloud.callFunction({ name: 'login' }).then(res => {
      if (res.result.success) {
        const roles = res.result.roles || []
        this.setData({
          roles: roles,
          isAdmin: roles.includes('food_admin') || roles.includes('market_admin') || roles.includes('super_admin')
        })
      }
    })
  },

  goToMyItems: function () {
    wx.navigateTo({ url: '/pages/myitems/myitems' })
  },
  goToMyOrders: function () {
    wx.navigateTo({ url: '/pages/myorders/myorders' })  // 我的订单(已有)
  }
})