const { guideProfileSetupOnce } = require('../../utils/user.js')

Page({
  data: {},

  // 首页是启动后的落地页，新用户在这里就会收到完善资料的提示，
  // 不用等到他自己去点「我的」
  onShow: function () {
    const ready = getApp().globalData && getApp().globalData.profileReady
    if (!ready) return
    ready.then(profile => guideProfileSetupOnce(profile))
  },

  goToFood: function () {
    wx.navigateTo({ url: '/pages/index/index' })   // 饭搭子(现在的外卖首页)
  },
  foodClosed: function () {
    wx.showToast({ title: '外卖暂无法运营', icon: 'none' })
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