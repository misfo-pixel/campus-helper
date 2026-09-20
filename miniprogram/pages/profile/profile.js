const { myProfile, guideProfileSetupOnce } = require('../../utils/user.js')
const { SHOP_MODULE_ENABLED, TEAM_MODULE_ENABLED } = require('../../config.js')

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    roles: [],
    isAdmin: false,
    isSuperAdmin: false,
    canAudit: false,        // 超管 或 饭搭子管理员：能审店长和配送队
    canSeeDelivery: false,  // 饭搭子管理员 / 有店的店长 / 已在队里的人
    shopEnabled: SHOP_MODULE_ENABLED,
    teamEnabled: TEAM_MODULE_ENABLED,
    pendingReports: 0
  },
  goToEdit: function () {
    wx.navigateTo({ url: '/pages/editprofile/editprofile' })
  },
  goToReports: function () {
    wx.navigateTo({ url: '/pages/reports/reports' })
  },
  goToAgreement: function () {
    wx.navigateTo({ url: '/pages/agreement/agreement' })
  },
  goToShop: function () {
    wx.navigateTo({ url: '/pages/shopdashboard/shopdashboard' })
  },
  goToFoodOrders: function () {
    wx.navigateTo({ url: '/pages/myfoodorders/myfoodorders' })
  },
  goToTeam: function () {
    wx.navigateTo({ url: '/pages/teamdashboard/teamdashboard' })
  },
  goToFeedbacks: function () {
    wx.navigateTo({ url: '/pages/feedbacks/feedbacks' })
  },
  goToShopAudit: function () {
    wx.navigateTo({ url: '/pages/shopaudit/shopaudit' })
  },
  goToMySublets: function () {
    wx.navigateTo({ url: '/pages/mysublets/mysublets' })
  },
  goToMyTasks: function () {
    wx.navigateTo({ url: '/pages/mytasks/mytasks' })
  },

  // 编辑资料返回时会再走一次 onShow，改动就刷新出来了
  onShow: function () {
    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      const roles = profile.roles
      const isAdmin = roles.includes('food_admin') || roles.includes('market_admin') || roles.includes('super_admin')
      const isFoodAdmin = roles.includes('food_admin')
      const isSuper = roles.includes('super_admin')

      this.setData({
        roles: roles,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        isAdmin: isAdmin,
        isSuperAdmin: isSuper,
        canAudit: isSuper || isFoodAdmin,
        // 先按角色给一次，下面再根据「有没有店 / 在不在队里」补
        canSeeDelivery: isSuper || isFoodAdmin
      })
      guideProfileSetupOnce(profile)
      if (isAdmin) this.loadPendingReports()
      if (TEAM_MODULE_ENABLED && SHOP_MODULE_ENABLED && !this.data.canSeeDelivery) this.checkDeliveryAccess()
    }).catch(err => {
      console.error('加载个人资料失败：', err)
    })
  },

  // 配送工作台不对普通用户开放，但店长和已经在队里的人得能进去。
  // 角色判断不出来的这两种情况，只能实际查一下。
  checkDeliveryAccess: function () {
    Promise.all([
      wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }),
      wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'getMine' } })
    ]).then(([shopRes, teamRes]) => {
      const hasShop = !!((shopRes && shopRes.result && shopRes.result.shop))
      const inTeam = !!((teamRes && teamRes.result && teamRes.result.team))
      if (hasShop || inTeam) this.setData({ canSeeDelivery: true })
    }).catch(err => {
      console.error('判断配送入口权限失败：', err)
    })
  },

  // 未处理举报数，给管理员在入口上挂个红点
  loadPendingReports: function () {
    wx.cloud.callFunction({ name: 'getReports', data: { status: 'pending' } }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) this.setData({ pendingReports: (r.reports || []).length })
    }).catch(err => {
      console.error('读取举报数失败：', err)
    })
  },

  goToMyItems: function () {
    wx.navigateTo({ url: '/pages/myitems/myitems' })
  }
})
