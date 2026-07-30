// pages/publishselect/publishselect.js
Page({
  data: {},

  publishItem: function () {
    wx.navigateTo({ url: '/pages/publish/publish' })  // 二手发布页(已做好)
  },
  publishSublet: function () {
    wx.navigateTo({ url: '/pages/subletpublish/subletpublish' })
  },
  publishTask: function () {
    wx.navigateTo({ url: '/pages/taskpublish/taskpublish' })
  },
})