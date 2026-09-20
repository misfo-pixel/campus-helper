// pages/publishselect/publishselect.js
const { guideProfileSetupOnce } = require('../../utils/user.js')

Page({
  data: {},

  // 完善资料的提示放在用户主动进「发布」时，不放首页：
  // 审核要求先让用户浏览功能，再由用户自己选择是否设置头像昵称
  onShow: function () {
    const ready = getApp().globalData && getApp().globalData.profileReady
    if (!ready) return
    ready.then(profile => guideProfileSetupOnce(profile))
  },

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