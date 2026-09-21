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
  uploadShopImage, validatePlan, markTeams
} = require('../../utils/shopForm.js')

const LAST_STEP = 3

Page({
  data: {
    step: 1,
    saving: false,

    // 第 1 步：这家店是什么
    name: '',
    description: '',

    // 第 2 步：要不要线下交付 + 谁来送
    teamEnabled: TEAM_MODULE_ENABLED,
    needsDelivery: null,      // null = 还没选，两张卡片都不高亮
    // 两层：先 exactAddress（送上门 or 买家自取），再 deliveryMode（谁送）
    exactAddress: false,
    deliveryMode: 'self',     // self 我自己送 / team 找配送队
    flat_delivery_fee: '',
    planPoints: [],
    planBatches: [],

    // 绑定哪一支配送队。和小店设置页同一套逻辑，注释见 shopedit.js
    deliveryTeamId: '',
    teams: [],
    teamsError: false,
    teamPickDisabled: false,
    teamPickReason: '',
    teamWarn: '',

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
    if (TEAM_MODULE_ENABLED) this.loadTeams()
  },

  loadTeams: function () {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'listTeams' }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ teamsError: true }, () => this.refreshTeamPick())
        return
      }
      this.setData({ teams: r.teams || [], teamsError: false }, () => this.refreshTeamPick())
    }).catch(err => {
      console.error('读取配送队失败：', err)
      this.setData({ teamsError: true }, () => this.refreshTeamPick())
    })
  },

  // 哪些队现在能选：拿第 2 步填的送达时刻前后各半小时，去比队伍的可配送
  // 时段，整段盖得住才算能接。规则在 utils/shopForm.js 的 markTeams 里，
  // 和小店设置页共用一份。
  //
  // 送达时间在这一步排在配送方式之前，就是为了这个——先有时间才判断得了
  // 有没有队能接。日期还没选的时候不置灰（markTeams 里一律算可选）。
  //
  // 读失败时也不置灰：那是「不知道有没有队」，不是「没有队」。
  refreshTeamPick: function () {
    const marked = markTeams(this.data.teams, this.data.planBatches, this.data.deliveryTeamId)
    this.setData({
      teams: marked.teams,
      teamPickDisabled: !this.data.teamsError && marked.disabled,
      teamPickReason: marked.reason,
      teamWarn: this.data.teamsError ? '' : marked.warn
    })
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 两个 plan-editor 实例各抛一半（服务时间 / 服务地点），按 key 合并。
  // 改了服务时间就要重算队伍可选性——「哪支队能接」完全跟着送达时间走。
  onPlanChange: function (e) {
    const d = e.detail || {}
    const patch = {}
    if (d.points) patch.planPoints = d.points
    if (d.batches) patch.planBatches = d.batches
    if (!Object.keys(patch).length) return
    this.setData(patch, () => {
      if (d.batches) this.refreshTeamPick()
    })
  },

  onAgreeChange: function (e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },

  // 两张大卡片二选一，比一个 switch 更说得清「这是个岔路口」
  pickDelivery: function (e) {
    this.setData({ needsDelivery: e.currentTarget.dataset.need === '1' })
  },

  onExactAddressChange: function (e) {
    this.setData({ exactAddress: e.detail.value })
  },

  pickMode: function (e) {
    const mode = e.currentTarget.dataset.mode

    if (mode === 'team' && this.data.teamPickDisabled) {
      wx.showToast({ title: this.data.teamPickReason, icon: 'none' })
      return
    }

    this.setData({ deliveryMode: mode })

    // 只有一支队可选时（现阶段大概率如此）自动选上，省一次点击
    if (mode === 'team' && !this.data.deliveryTeamId) {
      const usable = (this.data.teams || []).filter(t => t.selectable)
      if (usable.length === 1) this.setData({ deliveryTeamId: usable[0]._id }, () => this.refreshTeamPick())
    }
  },

  pickTeam: function (e) {
    const { id, selectable } = e.currentTarget.dataset
    if (!selectable) {
      wx.showToast({ title: '这支队在送达前后半小时里没空', icon: 'none' })
      return
    }
    this.setData({ deliveryTeamId: id }, () => this.refreshTeamPick())
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
        const bad = validatePlan(d.planPoints, d.planBatches, d.exactAddress)
        if (bad) {
          wx.showToast({ title: bad, icon: 'none' })
          return
        }
        if (d.exactAddress && d.deliveryMode === 'team' && !d.deliveryTeamId) {
          wx.showToast({ title: '请选择一支配送队', icon: 'none' })
          return
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
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          order_notice: d.order_notice,
          contact_wechat: d.contact_wechat,
          needs_delivery: d.needsDelivery === true,
          exact_address: d.exactAddress,
          delivery_mode: d.deliveryMode,
          delivery_team_id: d.deliveryTeamId,
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
