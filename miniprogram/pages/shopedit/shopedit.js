// 小店设置。只给已经有店的人用——开店走的是 pages/shopcreate 那个向导。
//
// 分开是有意的：开店的人还不知道要填什么，得被引着一步步走；
// 已经开了店的人通常只想改一个字段，一张长表单比三屏向导快。
// 两边共用的图片上传、方案校验在 utils/shopForm.js。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { ORDERING_ENABLED, EXACT_ADDRESS_ENABLED } = require('../../config.js')
const { uploadShopImage, validatePlan } = require('../../utils/shopForm.js')

Page({
  data: {
    // 黄页模式下这张表只剩「店是什么 + 怎么联系」：配送、起送价、
    // 下单补充说明全都依附于订单，订单没了它们就是在问废话。
    ordering: ORDERING_ENABLED,
    loading: true,
    saving: false,

    name: '',
    logo: '',          // 已保存的云文件 ID，或本次新选的本地临时路径
    tempLogo: '',      // 本次新选的本地文件，提交时才上传
    description: '',
    min_order: '',
    business_hours: '',
    contact_wechat: '',

    // 收款方式展示位。默认关，平台不主动把人往站外支付上引。
    noteRequired: false,
    note_hint: '',

    // 有没有线下交付。关掉的是纯线上服务，云函数会把地点和场次清空
    //（见 shopManage 的 pickShopFields）。到店自提不关这个开关——
    // 自提照样要地点和时间，只是配送费填 0。
    needsDelivery: true,

    exactAddress: false,      // 送到买家地址 / 送到几个取货点
    exactAddressEnabled: EXACT_ADDRESS_ENABLED,
    flat_delivery_fee: '',

    // 资质：凭证选填。平台不核实，传了就在小店页店名旁挂「证」标公开展示，不传也能开店——
    // 店长多是学生，硬卡一道「我已取得资质」的声明只会把人挡在门外。
    licenseImage: '',
    tempLicense: '',

    // 自送时才用：这家店自己的服务地点和批次
    planPoints: [],
    planBatches: []
  },

  onLoad: function () {
    this.loadShop()
  },

  loadShop: function () {
    return wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}

      // 读失败时 r.shop 同样是 undefined。不判 success 的话，一次网络抖动
      // 会把一个开着店的店长踢进开店向导，让他以为店没了。
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

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
        description: shop.description || '',
        min_order: shop.min_order === 0 ? '0' : String(shop.min_order || ''),
        business_hours: shop.business_hours || '',
        contact_wechat: shop.contact_wechat || '',
        noteRequired: shop.note_required === true,
        note_hint: shop.note_hint || '',
        // 老店铺没这个字段，按「有线下交付」算，跟云函数那边的默认一致
        needsDelivery: shop.needs_delivery !== false,
        // 送上门关着的时候，老的送上门店铺按取货点展示，店长补上点位保存就转过来了
        exactAddress: EXACT_ADDRESS_ENABLED && shop.exact_address === true,
        flat_delivery_fee: shop.flat_delivery_fee ? String(shop.flat_delivery_fee) : '',
        licenseImage: shop.license_image || '',
        planPoints: shop.pickup_points || [],
        planBatches: shop.batches || []
      })
    }).catch(err => {
      console.error('读取小店失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 服务时间和服务地点现在是两个 plan-editor 实例（排在「送到哪里」
  // 分段按钮的两侧），各只抛自己那一半，所以这里按 key 合并，不能整个覆盖。
  onPlanChange: function (e) {
    const d = e.detail || {}
    const patch = {}
    if (d.points) patch.planPoints = d.points
    if (d.batches) patch.planBatches = d.batches
    if (!Object.keys(patch).length) return
    this.setData(patch)
  },

  onNoteRequiredChange: function (e) {
    this.setData({ noteRequired: e.detail.value })
  },

  onNeedsDeliveryChange: function (e) {
    this.setData({ needsDelivery: e.detail.value })
  },

  // 送到买家地址 / 送到模糊地址，分段按钮二选一
  pickExactAddress: function (e) {
    this.setData({ exactAddress: e.currentTarget.dataset.exact === '1' })
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
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
      const bad = validatePlan(d.planPoints, d.planBatches, d.exactAddress)
      if (bad) {
        wx.showToast({ title: bad, icon: 'none' })
        return
      }
      // 云函数那边也拦一道，这里先拦是为了不让店长白等一个来回
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      // 小店资料是公开展示的内容，一样要过内容安全检测
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.business_hours, d.contact_wechat, d.note_hint]
      }))) return

      const logo = await uploadShopImage(d.tempLogo, d.logo, 'shops')
      const licenseImage = await uploadShopImage(d.tempLicense, d.licenseImage, 'licenses')
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
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          contact_wechat: d.contact_wechat,
          note_required: d.noteRequired,
          note_hint: d.noteRequired ? d.note_hint : '',
          needs_delivery: d.needsDelivery,
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
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }

      // 营业中改了服务时间 = 开了新的一场。打烊中保存的话服务端直接跳过，
      // 等店长在工作台挂上营业中时再发。
      // 开团提醒：通知订阅了这家店的买家。不等结果——服务端自己判断
      // 是不是新的一场，同一场只发一次，所以这里多调几次也不会重复打扰人。
      wx.cloud.callFunction({ name: 'shopSubscribe', data: { action: 'announce' } })
        .catch(err => console.warn('开团提醒触发失败：', err))

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
