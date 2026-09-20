// 开店向导。一步步问，不是甩一张长表单。
//
// 和 pages/shopedit 分开是有意的：开店的人还不知道自己要填什么，
// 需要被引着走；已经开了店的人只想改一个字段，长表单反而更快。
// 两边共用的分类口径、上传、方案校验在 utils/shopForm.js。
//
// 三步只是 step 状态切换，不是三个页面——填到一半的内容留在内存里，
// 点「上一步」不会丢。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { TEAM_MODULE_ENABLED } = require('../../config.js')
const {
  CATEGORIES, uploadShopImage, validatePlan
} = require('../../utils/shopForm.js')

const LAST_STEP = 3

Page({
  data: {
    step: 1,
    saving: false,

    // 第 1 步：这家店是什么
    name: '',
    categories: CATEGORIES,
    categoryIndex: 0,
    description: '',

    // 第 2 步：要不要配送
    teamEnabled: TEAM_MODULE_ENABLED,
    needsDelivery: null,      // null = 还没选，两张卡片都不高亮
    deliveryMode: 'self',
    teams: [],
    teamNames: [],
    teamIndex: null,
    planPoints: [],
    planBatches: [],

    // 第 3 步：怎么找到你
    contact_wechat: '',
    logo: '',
    tempLogo: '',
    business_hours: '',
    min_order: '',
    order_notice: '',
    licenseImage: '',
    tempLicense: '',
    agreed: false
  },

  onLoad: function () {
    this.loadTeams()
  },

  // 审核通过的配送队，外包时从这里选
  loadTeams: function () {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'listApproved' }
    }).then(res => {
      const r = (res && res.result) || {}
      const teams = r.success ? (r.teams || []) : []
      this.setData({ teams: teams, teamNames: teams.map(t => t.name) })
    }).catch(err => {
      console.error('读取配送队失败：', err)
    })
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  onCategoryChange: function (e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onTeamChange: function (e) {
    this.setData({ teamIndex: Number(e.detail.value) })
  },

  onPlanChange: function (e) {
    this.setData({ planPoints: e.detail.points, planBatches: e.detail.batches })
  },

  onAgreeChange: function (e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },

  // 两张大卡片二选一，比一个 switch 更说得清「这是个岔路口」
  pickDelivery: function (e) {
    this.setData({ needsDelivery: e.currentTarget.dataset.need === '1' })
  },

  pickMode: function (e) {
    this.setData({ deliveryMode: e.currentTarget.dataset.mode })
  },

  chooseLogo: function () {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ logo: path, tempLogo: path })
      }
    })
  },

  chooseLicense: function () {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ licenseImage: path, tempLicense: path })
      }
    })
  },

  prev: function () {
    if (this.data.step > 1) this.setData({ step: this.data.step - 1 })
  },

  // 每一步都在原地拦住，不让人带着空字段走到最后一屏才被退回来
  next: function () {
    const d = this.data

    if (d.step === 1) {
      if (!d.name.trim()) {
        wx.showToast({ title: '给小店起个名字', icon: 'none' })
        return
      }
    }

    if (d.step === 2) {
      if (d.needsDelivery === null) {
        wx.showToast({ title: '先选要不要配送', icon: 'none' })
        return
      }
      if (d.needsDelivery) {
        if (d.deliveryMode === 'outsourced' && d.teamIndex === null) {
          wx.showToast({ title: '请选择要外包给哪个配送队', icon: 'none' })
          return
        }
        if (d.deliveryMode === 'self') {
          const bad = validatePlan(d.planPoints, d.planBatches)
          if (bad) {
            wx.showToast({ title: bad, icon: 'none' })
            return
          }
        }
      }
    }

    if (d.step < LAST_STEP) this.setData({ step: d.step + 1 })
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: '请填写联系微信', icon: 'none' })
      return
    }
    if (!d.agreed) {
      wx.showToast({ title: '请先阅读并同意店长责任告知书', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '开店中...', mask: true })

    try {
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.business_hours, d.order_notice, d.contact_wechat]
      }))) return

      const logo = await uploadShopImage(d.tempLogo, d.logo, 'shops')
      const licenseImage = await uploadShopImage(d.tempLicense, d.licenseImage, 'licenses')

      if (d.tempLogo && logo) {
        if (!(await ensureContentOk({ fileIDs: [logo] }))) {
          await deleteCloudFiles([logo])
          return
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'shopManage',
        data: {
          action: 'apply',
          agreed: true,
          name: d.name,
          logo: logo,
          category: CATEGORIES[d.categoryIndex],
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          order_notice: d.order_notice,
          contact_wechat: d.contact_wechat,
          needs_delivery: d.needsDelivery === true,
          delivery_mode: d.deliveryMode,
          delivery_team_id: (!TEAM_MODULE_ENABLED || d.teamIndex === null) ? '' : d.teams[d.teamIndex]._id,
          license_image: licenseImage,
          pickup_points: d.planPoints,
          batches: d.planBatches
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '开店失败', icon: 'none' })
        return
      }

      wx.showModal({
        title: '小店开好了',
        content: '接下来去上架商品，然后把状态切成「营业中」就能接单。',
        showCancel: false,
        confirmText: '去上架',
        success: () => wx.redirectTo({ url: '/pages/shopmenu/shopmenu' })
      })
    } catch (err) {
      wx.hideLoading()
      console.error('开店失败：', err)
      wx.showToast({ title: '开店失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  openAgreement: function () {
    wx.navigateTo({ url: '/pages/shopagreement/shopagreement' })
  }
})
