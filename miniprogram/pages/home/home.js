Page({
  data: {},

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