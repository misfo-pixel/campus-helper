const { guideProfileSetupOnce } = require('../../utils/user.js')
const { FOOD_MODULE_ENABLED, SHOP_MODULE_ENABLED } = require('../../config.js')

Page({
  data: {
    foodEnabled: FOOD_MODULE_ENABLED,
    shopEnabled: SHOP_MODULE_ENABLED
  },

  // 首页是启动后的落地页，新用户在这里就会收到完善资料的提示，
  // 不用等到他自己去点「我的」
  onShow: function () {
    const ready = getApp().globalData && getApp().globalData.profileReady
    if (!ready) return
    ready.then(profile => guideProfileSetupOnce(profile))
  },

  // 外卖入口关掉时整块不渲染，这个跳转也走不到；恢复见 config.js
  goToFood: function () {
    wx.navigateTo({ url: '/pages/index/index' })   // 饭搭子(现在的外卖首页)
  },
  goToShops: function () {
    wx.navigateTo({ url: '/pages/shoplist/shoplist' })   // 校园餐厅（商家自营）
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