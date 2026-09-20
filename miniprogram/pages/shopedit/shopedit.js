// 小店设置。只给已经有店的人用——开店走的是 pages/shopcreate 那个向导。
//
// 分开是有意的：开店的人还不知道要填什么，得被引着一步步走；
// 已经开了店的人通常只想改一个字段，一张长表单比三屏向导快。
// 两边共用的分类口径、老数据映射、图片上传、方案校验在 utils/shopForm.js。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { TEAM_MODULE_ENABLED } = require('../../config.js')
const {
  CATEGORIES, categoryIndexOf, uploadShopImage, validatePlan
} = require('../../utils/shopForm.js')

Page({
  data: {
    loading: true,
    saving: false,

    name: '',
    logo: '',          // 已保存的云文件 ID，或本次新选的本地临时路径
    tempLogo: '',      // 本次新选的本地文件，提交时才上传
    categoryIndex: 0,
    categories: CATEGORIES,
    description: '',
    min_order: '',
    business_hours: '',
    order_notice: '',
    contact_wechat: '',

    // 收款方式展示位。默认关，平台不主动把人往站外支付上引。
    paymentEnabled: false,
    payment_note: '',
    paymentQr: '',
    tempPaymentQr: '',

    // 要不要配送。关掉之后服务地点、服务时间、配送费整套都不适用，
    // 云函数那边会把这三项清空（见 shopManage 的 pickShopFields）。
    needsDelivery: true,

    teamEnabled: TEAM_MODULE_ENABLED,

    // 配送方式：自己送 / 外包给配送队。
    // 服务地点和批次归实际送货的一方：自己送就在方案编辑器里填，外包就用队伍那份。
    deliveryMode: 'self',
    teams: [],
    teamNames: [],
    teamIndex: null,

    // 资质：凭证选填。平台不核实，传了就留档，不传也能开店——
    // 店长多是学生，硬卡一道「我已取得资质」的声明只会把人挡在门外。
    licenseImage: '',
    tempLicense: '',

    // 自送时才用：这家店自己的服务地点和批次
    planPoints: [],
    planBatches: []
  },

  onLoad: function () {
    this.loadTeams().then(() => this.loadShop())
  },

  loadShop: function () {
    return wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}
      const shop = r.shop

      // 没店的人不该站在设置页上，直接送去开店向导
      if (!shop) {
        wx.redirectTo({ url: '/pages/shopcreate/shopcreate' })
        return
      }

      this.setData({
        loading: false,
        name: shop.name || '',
        logo: shop.logo || '',
        categoryIndex: categoryIndexOf(shop.category),
        description: shop.description || '',
        min_order: shop.min_order === 0 ? '0' : String(shop.min_order || ''),
        business_hours: shop.business_hours || '',
        order_notice: shop.order_notice || '',
        contact_wechat: shop.contact_wechat || '',
        paymentEnabled: shop.payment_enabled === true,
        payment_note: shop.payment_note || '',
        paymentQr: shop.payment_qr || '',
        // 老店铺没这个字段，按「要配送」算，跟云函数那边的默认保持一致
        needsDelivery: shop.needs_delivery !== false,
        // 队伍模块关掉时一律按自送读，否则老店铺会停在一个界面上改不了的状态
        deliveryMode: TEAM_MODULE_ENABLED ? (shop.delivery_mode || 'self') : 'self',
        licenseImage: shop.license_image || '',
        planPoints: shop.pickup_points || [],
        planBatches: shop.batches || []
      }, () => this.markTeam(shop.delivery_team_id))
    }).catch(err => {
      console.error('读取小店失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 通过核对的配送队，外包时从这里选
  loadTeams: function () {
    return wx.cloud.callFunction({
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

  // 小店原本绑的那个队，在列表里定位一下
  markTeam: function (teamId) {
    if (!teamId) return
    const idx = this.data.teams.findIndex(t => t._id === teamId)
    if (idx >= 0) this.setData({ teamIndex: idx })
  },

  // 方案编辑器每次改动都把完整的两份数组抛回来
  onPlanChange: function (e) {
    this.setData({ planPoints: e.detail.points, planBatches: e.detail.batches })
  },

  onPaymentEnabledChange: function (e) {
    this.setData({ paymentEnabled: e.detail.value })
  },

  choosePaymentQr: function () {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ paymentQr: path, tempPaymentQr: path })
      }
    })
  },

  onNeedsDeliveryChange: function (e) {
    this.setData({ needsDelivery: e.detail.value })
  },

  onDeliveryModeChange: function (e) {
    this.setData({ deliveryMode: e.detail.value })
  },

  onTeamChange: function (e) {
    this.setData({ teamIndex: Number(e.detail.value) })
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  onCategoryChange: function (e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
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

  submit: async function () {
    const d = this.data
    if (d.saving) return

    // 漏填时指名道姓，而不是甩一句「请填完必填项」让店长自己回去找
    if (!d.name) {
      wx.showToast({ title: '请填写小店名称', icon: 'none' })
      return
    }
    if (!d.contact_wechat) {
      wx.showToast({ title: '请填写联系微信', icon: 'none' })
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

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      // 小店资料是公开展示的内容，一样要过内容安全检测
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.business_hours, d.order_notice, d.contact_wechat, d.payment_note]
      }))) return

      const logo = await uploadShopImage(d.tempLogo, d.logo, 'shops')
      const licenseImage = await uploadShopImage(d.tempLicense, d.licenseImage, 'licenses')
      const paymentQr = d.paymentEnabled
        ? await uploadShopImage(d.tempPaymentQr, d.paymentQr, 'payqr')
        : ''

      // 换了新 Logo 才需要检测，没换的是之前已经检过的
      if (d.tempLogo && logo) {
        if (!(await ensureContentOk({ fileIDs: [logo] }))) {
          await deleteCloudFiles([logo])
          return
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'shopManage',
        data: {
          action: 'update',
          name: d.name,
          logo: logo,
          category: CATEGORIES[d.categoryIndex],
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          order_notice: d.order_notice,
          contact_wechat: d.contact_wechat,
          payment_enabled: d.paymentEnabled,
          payment_note: d.paymentEnabled ? d.payment_note : '',
          payment_qr: paymentQr,
          needs_delivery: d.needsDelivery,
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
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }

      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1000)
    } catch (err) {
      wx.hideLoading()
      console.error('保存小店失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  openAgreement: function () {
    wx.navigateTo({ url: '/pages/shopagreement/shopagreement' })
  }
})
