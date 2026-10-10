// pages/publishselect/publishselect.js
const { guideProfileSetupOnce } = require('../../utils/user.js')
const { GROUP_MODULE_ENABLED } = require('../../config.js')
const { layoutTiles } = require('../../utils/tiles.js')

// 图标和底色跟首页同一个模块对得上：首页黄色的是二手，这里黄色的也是二手
const TILES = [
  { key: 'market', title: '发布闲置', sub: '闲置变现金，几步搞定', color: 'gold', url: '/pages/publish/publish' },
  { key: 'sublet', title: '发布转租', sub: '找到下一位租客', color: '', url: '/pages/subletpublish/subletpublish' },
  { key: 'task', title: '发布委托', sub: '求购物品 / 找人帮忙', color: 'maroon', url: '/pages/taskpublish/taskpublish' },
  { key: 'group', title: '发布群组', sub: '凑人、组队、拉群', color: '', url: '/pages/grouppublish/grouppublish',
    enabled: GROUP_MODULE_ENABLED }
]

Page({
  data: {
    tiles: layoutTiles(TILES)
  },

  // 完善资料的提示放在用户主动进「发布」时，不放首页：
  // 审核要求先让用户浏览功能，再由用户自己选择是否设置头像昵称
  onShow: function () {
    const ready = getApp().globalData && getApp().globalData.profileReady
    if (!ready) return
    ready.then(profile => guideProfileSetupOnce(profile))
  },

  onTapTile: function (e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  }
})
