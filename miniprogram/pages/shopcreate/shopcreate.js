// 开店向导。一步步问，不是甩一张长表单。
//
// 和 pages/shopedit 分开是有意的：开店的人还不知道自己要填什么，
// 需要被引着走；已经开了店的人只想改一个字段，长表单反而更快。
// 两边共用的分类口径、上传、方案校验在 utils/shopForm.js。
//
// 三步只是 step 状态切换，不是三个页面——填到一半的内容留在内存里，
// 点「上一步」不会丢。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { ORDERING_ENABLED, EXACT_ADDRESS_ENABLED } = require('../../config.js')
const { uploadShopImage, validatePlan } = require('../../utils/shopForm.js')

const LAST_STEP = 3

Page({
  data: {
    // 黄页模式没有配送这回事，第 2 步整屏跳过：向导从三步变两步。
    // step 的编号不变（1 → 3），只是进度条少画一个点——改编号要动
    // next / prev / 每个 block 的条件，得不偿失。
    ordering: ORDERING_ENABLED,
    step: 1,
    saving: false,

    // 第 1 步：这家店是什么
    name: '',
    description: '',

    // 第 2 步：要不要线下交付、送到哪
    needsDelivery: null,      // null = 还没选，两张卡片都不高亮
    exactAddress: false,      // 送到买家地址 / 送到几个取货点
    exactAddressEnabled: EXACT_ADDRESS_ENABLED,
    flat_delivery_fee: '',
    planPoints: [],
    planBatches: [],

    // 第 3 步：怎么找到你
    contact_wechat: '',
    logo: '',
    tempLogo: '',
    business_hours: '',
    min_order: '',
    licenseImage: '',
    tempLicense: '',
    agreed: false
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 两个 plan-editor 实例各抛一半（服务时间 / 服务地点），按 key 合并。
  onPlanChange: function (e) {
    const d = e.detail || {}
    const patch = {}
    if (d.points) patch.planPoints = d.points
    if (d.batches) patch.planBatches = d.batches
    if (!Object.keys(patch).length) return
    this.setData(patch)
  },

  onAgreeChange: function (e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },

  // 两张大卡片二选一，比一个 switch 更说得清「这是个岔路口」
  pickDelivery: function (e) {
    this.setData({ needsDelivery: e.currentTarget.dataset.need === '1' })
  },

  // 送到买家地址 / 送到模糊地址，分段按钮二选一
  pickExactAddress: function (e) {
    this.setData({ exactAddress: e.currentTarget.dataset.exact === '1' })
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
    const d = this.data
    if (d.step <= 1) return
    this.setData({ step: (!ORDERING_ENABLED && d.step === 3) ? 1 : d.step - 1 })
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
        const bad = validatePlan(d.planPoints, d.planBatches, d.exactAddress)
        if (bad) {
          wx.showToast({ title: bad, icon: 'none' })
          return
        }
      }
    }

    // 黄页模式从第 1 步直接跳到第 3 步
    if (d.step === 1 && !ORDERING_ENABLED) {
      this.setData({ step: LAST_STEP })
      return
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
        texts: [d.name, d.description, d.business_hours, d.contact_wechat]
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
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          contact_wechat: d.contact_wechat,
          needs_delivery: d.needsDelivery === true,
          exact_address: d.exactAddress,
          flat_delivery_fee: d.flat_delivery_fee,
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
