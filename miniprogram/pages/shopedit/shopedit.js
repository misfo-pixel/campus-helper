// 小店设置。只给已经有店的人用——开店走的是 pages/shopcreate 那个向导。
//
// 分开是有意的：开店的人还不知道要填什么，得被引着一步步走；
// 已经开了店的人通常只想改一个字段，一张长表单比三屏向导快。
// 两边共用的图片上传、方案校验在 utils/shopForm.js。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { ORDERING_ENABLED, EXACT_ADDRESS_ENABLED } = require('../../config.js')
const { uploadShopImage, validatePoints } = require('../../utils/shopForm.js')
const { t } = require('../../i18n/index.js')

Page({
  data: {
    // 黄页模式下这张表只剩「店是什么 + 怎么联系」：配送、起送价、
    // 下单补充说明全都依附于订单，订单没了它们就是在问废话。
    ordering: ORDERING_ENABLED,
    loading: true,
    saving: false,
    deleting: false,

    name: '',
    logo: '',          // 已保存的云文件 ID，或本次新选的本地临时路径
    tempLogo: '',      // 本次新选的本地文件，提交时才上传
    description: '',
    min_order: '',
    wait_minutes: '',  // 送到后等买家几分钟，空着就是 10
    contact_phone: '',
    slogan: '',        // 广告语：海报大标题、店长自己转发时的卡片标题

    // 收款方式展示位。默认关，平台不主动把人往站外支付上引。
    noteRequired: false,
    note_hint: '',

    // 有没有线下交付。2026-10-11 起没有这个开关了，新店一律要；
    // 老的纯线上服务店不显示取货点那张卡，云函数那边也保留原值
    needsDelivery: true,

    exactAddress: false,      // 送到买家地址 / 送到几个取货点
    exactAddressEnabled: EXACT_ADDRESS_ENABLED,
    flat_delivery_fee: '',

    // 资质：凭证选填。平台不核实，传了就在小店页店名旁挂「证」标公开展示，不传也能开店——
    // 店长多是学生，硬卡一道「我已取得资质」的声明只会把人挡在门外。
    licenseImage: '',
    tempLicense: '',

    // 这家店的取货点。场次不在这里设，在「我的小店」的日历里开团
    planPoints: []
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
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
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
        wait_minutes: shop.wait_minutes ? String(shop.wait_minutes) : '',
        contact_phone: shop.contact_phone || '',
        slogan: shop.slogan || '',
        noteRequired: shop.note_required === true,
        note_hint: shop.note_hint || '',
        // 老店铺没这个字段，按「有线下交付」算，跟云函数那边的默认一致
        needsDelivery: shop.needs_delivery !== false,
        // 送上门关着的时候，老的送上门店铺按取货点展示，店长补上点位保存就转过来了
        exactAddress: EXACT_ADDRESS_ENABLED && shop.exact_address === true,
        flat_delivery_fee: shop.flat_delivery_fee ? String(shop.flat_delivery_fee) : '',
        licenseImage: shop.license_image || '',
        planPoints: shop.pickup_points || []
      })
    }).catch(err => {
      console.error('读取小店失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  onPlanChange: function (e) {
    const d = e.detail || {}
    if (d.points) this.setData({ planPoints: d.points })
  },

  onNoteRequiredChange: function (e) {
    this.setData({ noteRequired: e.detail.value })
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
      wx.showToast({ title: t('请填写小店名称'), icon: 'none' })
      return
    }
    const phoneDigits = d.contact_phone.replace(/\D/g, '')
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      wx.showToast({ title: t('请填写正确的手机号'), icon: 'none' })
      return
    }
    if (d.needsDelivery && !d.exactAddress) {
      // 云函数那边也拦一道，这里先拦是为了不让店长白等一个来回
      const bad = validatePoints(d.planPoints)
      if (bad) {
        wx.showToast({ title: t(bad), icon: 'none' })
        return
      }
    }

    this.setData({ saving: true })
    wx.showLoading({ title: t('保存中...'), mask: true })

    try {
      // 小店资料是公开展示的内容，一样要过内容安全检测
      if (!(await ensureContentOk({
        texts: [d.name, d.slogan, d.description, d.note_hint]
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
          wait_minutes: d.wait_minutes,
          contact_phone: d.contact_phone,
          slogan: d.slogan,
          note_required: d.noteRequired,
          note_hint: d.noteRequired ? d.note_hint : '',
          exact_address: d.exactAddress,
          flat_delivery_fee: d.flat_delivery_fee,
          license_image: licenseImage,
          pickup_points: d.planPoints
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '保存失败'), icon: 'none' })
        return
      }

      wx.showToast({ title: t('已保存'), icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1000)
    } catch (err) {
      wx.hideLoading()
      console.error('保存小店失败：', err)
      wx.showToast({ title: t('保存失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 能不能删由云函数判断（有没办完的订单、是不是被下架了），这里只负责确认
  removeShop: function () {
    if (this.data.deleting) return
    wx.showModal({
      title: t('删除小店'),
      content: t('店铺、商品、场次和开团订阅会一起删掉，不能恢复。订单记录会保留。'),
      confirmText: t('删除'),
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return
        this.setData({ deleting: true })
        wx.cloud.callFunction({ name: 'shopManage', data: { action: 'remove' } }).then(r => {
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showModal({ title: t('删不了'), content: t(result.message || '删除失败，请重试'), showCancel: false })
            return
          }
          wx.showToast({ title: t('已删除'), icon: 'success' })
          setTimeout(() => wx.switchTab({ url: '/pages/profile/profile' }), 1000)
        }).catch(err => {
          console.error('删除小店失败：', err)
          wx.showToast({ title: t('删除失败，请重试'), icon: 'none' })
        }).then(() => {
          this.setData({ deleting: false })
        })
      }
    })
  },

  openAgreement: function () {
    wx.navigateTo({ url: '/pages/shopagreement/shopagreement' })
  }
})
