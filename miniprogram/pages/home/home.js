const { SHOP_MODULE_ENABLED } = require('../../config.js')

Page({
  data: {
    shopEnabled: SHOP_MODULE_ENABLED
  },

  goToShops: function () {
    wx.navigateTo({ url: '/pages/shoplist/shoplist' })   // 校外服务（商家自营）
  },
  goToMarket: function () {
    wx.navigateTo({ url: '/pages/market/market' })  // 二手市场
  },
  goToSublet: function () {
    wx.navigateTo({ url: '/pages/subletmarket/subletmarket' })
  },
  goToTask: function () {
    wx.navigateTo({ url: '/pages/taskmarket/taskmarket' })
  },
  goToFeedback: function () {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  }
})