// 入驻申请 + 店铺设置。
// 两个场景表单完全一样，只是一个 add 一个 update，所以合成一个页面用 isNew 区分，
// 免得维护两份长得一模一样的表单。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

const CATEGORIES = ['中餐', '奶茶饮品', '烘焙甜点', '快餐简餐', '其他']

Page({
  data: {
    isNew: true,
    loading: true,
    saving: false,
    agreed: false,

    name: '',
    logo: '',          // 已保存的云文件 ID，或本次新选的本地临时路径
    tempLogo: '',      // 本次新选的本地文件，提交时才上传
    categoryIndex: 0,
    categories: CATEGORIES,
    description: '',
    min_order: '',
    delivery_area: '',
    business_hours: '',
    payment_note: '',
    contact_wechat: '',

    auditStatus: '',
    auditReason: '',

    // 配送：商家只选「自己送」还是「外包给配送队」。
    // 取餐点费率和批次时间是平台统一维护的，两种方式跑同一套，商家不用填。
    deliveryMode: 'self',
    teams: [],
    teamNames: [],
    teamIndex: null,

    // 资质：商家自己声明并举证。平台不核实，只是把声明和凭证留档。
    licenseConfirmed: false,
    licenseImage: '',
    tempLicense: '',

    // 自送时才用：这家店自己的取餐点和批次
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

      if (!shop) {
        this.setData({ isNew: true, loading: false })
        return
      }

      const idx = CATEGORIES.indexOf(shop.category)
      this.setData({
        isNew: false,
        loading: false,
        name: shop.name || '',
        logo: shop.logo || '',
        categoryIndex: idx === -1 ? 0 : idx,
        description: shop.description || '',
        min_order: shop.min_order === 0 ? '0' : String(shop.min_order || ''),
        delivery_area: shop.delivery_area || '',
        business_hours: shop.business_hours || '',
        payment_note: shop.payment_note || '',
        contact_wechat: shop.contact_wechat || '',
        auditStatus: shop.audit_status || '',
        auditReason: shop.audit_reason || '',
        deliveryMode: shop.delivery_mode || 'self',
        licenseConfirmed: !!shop.license_confirmed,
        licenseImage: shop.license_image || '',
        planPoints: shop.pickup_points || [],
        planBatches: shop.batches || []
      }, () => this.markTeam(shop.delivery_team_id))
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 审核通过的配送队，外包时从这里选
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

  // 店铺原本绑的那个队，在列表里定位一下
  markTeam: function (teamId) {
    if (!teamId) return
    const idx = this.data.teams.findIndex(t => t._id === teamId)
    if (idx >= 0) this.setData({ teamIndex: idx })
  },

  // 方案编辑器每次改动都把完整的两份数组抛回来
  onPlanChange: function (e) {
    this.setData({ planPoints: e.detail.points, planBatches: e.detail.batches })
  },

  onLicenseChange: function (e) {
    this.setData({ licenseConfirmed: e.detail.value.length > 0 })
  },

  chooseLicense: function () {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ licenseImage: path, tempLicense: path })
      }
    })
  },

  uploadLicense: function () {
    const temp = this.data.tempLicense
    if (!temp) return Promise.resolve(this.data.licenseImage)

    const match = temp.match(/\.(\w+)$/)
    const ext = match ? match[1] : 'jpg'
    const cloudPath = 'licenses/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
    return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: temp }).then(r => r.fileID)
  },

  onDeliveryModeChange: function (e) {
    this.setData({ deliveryMode: e.detail.value })
  },

  onTeamChange: function (e) {
    this.setData({ teamIndex: Number(e.detail.value) })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onCategoryChange: function (e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onAgreeChange: function (e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },

  chooseLogo: function () {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ logo: path, tempLogo: path })
      }
    })
  },

  // 没换 Logo 就把原来的云文件 ID 原样返回
  uploadLogo: function () {
    const temp = this.data.tempLogo
    if (!temp) return Promise.resolve(this.data.logo)

    const match = temp.match(/\.(\w+)$/)
    const ext = match ? match[1] : 'jpg'
    const cloudPath = 'shops/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
    return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: temp }).then(r => r.fileID)
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    if (d.isNew && !d.agreed) {
      wx.showToast({ title: '请先阅读并同意商家责任告知书', icon: 'none' })
      return
    }
    if (!d.name || !d.contact_wechat || !d.payment_note) {
      wx.showToast({ title: '请填完必填项', icon: 'none' })
      return
    }
    if (d.deliveryMode === 'outsourced' && d.teamIndex === null) {
      wx.showToast({ title: '请选择要外包给哪个配送队', icon: 'none' })
      return
    }
    if (!d.licenseConfirmed) {
      wx.showToast({ title: '请确认你已取得所在地要求的食品经营资质', icon: 'none' })
      return
    }
    if (d.deliveryMode === 'self') {
      const points = (d.planPoints || []).filter(p => String(p.name || '').trim())
      const batches = (d.planBatches || []).filter(b => String(b.label || '').trim())
      if (!points.length) {
        wx.showToast({ title: '自己送的话，至少要设一个取餐点', icon: 'none' })
        return
      }
      if (!batches.length) {
        wx.showToast({ title: '自己送的话，至少要设一个配送批次', icon: 'none' })
        return
      }
      const names = points.map(p => p.name.trim())
      if (new Set(names).size !== names.length) {
        wx.showToast({ title: '取餐点名字不能重复', icon: 'none' })
        return
      }
      const labels = batches.map(b => b.label.trim())
      if (new Set(labels).size !== labels.length) {
        wx.showToast({ title: '批次名不能重复', icon: 'none' })
        return
      }
      if (batches.some(b => b.deliver_time <= b.cutoff)) {
        wx.showToast({ title: '到点时间要晚于截单时间', icon: 'none' })
        return
      }
    }

    this.setData({ saving: true })
    wx.showLoading({ title: d.isNew ? '提交中...' : '保存中...', mask: true })

    try {
      // 店铺资料是公开展示的内容，一样要过内容安全检测
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.delivery_area, d.business_hours, d.payment_note, d.contact_wechat]
      }))) return

      const logo = await this.uploadLogo()
      const licenseImage = await this.uploadLicense()

      // 换了新 Logo 才需要检测，没换的是之前已经检过的
      if (d.tempLogo && logo) {
        if (!(await ensureContentOk({ fileIDs: [logo] }))) {
          await deleteCloudFiles([logo])
          return
        }
      }

      const payload = {
        action: d.isNew ? 'apply' : 'update',
        agreed: d.agreed,
        name: d.name,
        logo: logo,
        category: CATEGORIES[d.categoryIndex],
        description: d.description,
        min_order: d.min_order,
        delivery_area: d.delivery_area,
        business_hours: d.business_hours,
        payment_note: d.payment_note,
        contact_wechat: d.contact_wechat,
        delivery_mode: d.deliveryMode,
        delivery_team_id: d.teamIndex === null ? '' : d.teams[d.teamIndex]._id,
        license_confirmed: d.licenseConfirmed,
        license_image: licenseImage,
        pickup_points: d.planPoints,
        batches: d.planBatches
      }

      const res = await wx.cloud.callFunction({ name: 'shopManage', data: payload })
      const r = (res && res.result) || {}
      wx.hideLoading()

      if (!r.success) {
        wx.showToast({ title: r.message || '提交失败', icon: 'none' })
        return
      }

      if (d.isNew) {
        wx.showModal({
          title: '已提交',
          content: '入驻申请已提交，我们会尽快审核。审核通过后就能上架菜品并开始营业。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      } else if (r.reaudit) {
        wx.showModal({
          title: '已保存',
          content: '你修改了店铺名称，需要重新审核。审核期间店铺会暂时停业。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      } else {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 1000)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存店铺失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  openAgreement: function () {
    wx.navigateTo({ url: '/pages/shopagreement/shopagreement' })
  }
})
