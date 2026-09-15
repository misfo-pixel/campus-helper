const { markStale } = require('../../utils/refresh.js')
const { fetchMyProfile } = require('../../utils/user.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { KINDS, isDemand } = require('../../utils/kinds.js')

const CFG = KINDS.sublet

Page({
  data: {
    kind: CFG.default,   // offer = 我要转租，seek = 我要找房
    kinds: CFG.tabs,
    demand: false,
    images: [],
    title: '',
    rent: '',
    address: '',
    contact_wechat: '',
    wechatAutoFilled: false,
    start_date: '',
    end_date: '',
    bedroomIndex: null,
    bathroomIndex: null,
    furnished: false,
    utilities: '',
    deposit: '',
    roommate_info: '',
    description: '',
    bedrooms: ['Studio', '1', '2', '3', '4', '5+'],
    bathrooms: ['1', '2', '3', '4+']
  },

  // 微信号自动填个人资料里存的那个，没存过就留空手填
  onLoad: function () {
    fetchMyProfile().then(profile => {
      if (profile.wechat && !this.data.contact_wechat) {
        this.setData({ contact_wechat: profile.wechat, wechatAutoFilled: true })
      }
    }).catch(err => {
      console.error('读取微信号失败：', err)
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  chooseImages: function () {
    wx.chooseMedia({
      count: 6 - this.data.images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],   // 压缩版才能过 imgSecCheck 的 1MB 上限
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({ images: this.data.images.concat(newImages) })
      }
    })
  },

  onStartDateChange: function (e) {
    this.setData({ start_date: e.detail.value })
  },
  onEndDateChange: function (e) {
    this.setData({ end_date: e.detail.value })
  },
  onBedroomChange: function (e) {
    this.setData({ bedroomIndex: e.detail.value })
  },
  onBathroomChange: function (e) {
    this.setData({ bathroomIndex: e.detail.value })
  },
  onFurnishedChange: function (e) {
    this.setData({ furnished: e.detail.value })
  },

  onTapKind: function (e) {
    const kind = e.currentTarget.dataset.key
    this.setData({ kind: kind, demand: isDemand(kind) })
  },

  submitPublish: async function () {
    const d = this.data
    // 必填校验：title, rent, address, contact_wechat, start_date, end_date, 房型
    if (!d.title || !d.rent || !d.address || !d.contact_wechat || !d.start_date || !d.end_date || d.bedroomIndex === null || d.bathroomIndex === null) {
      wx.showToast({ title: '请填完必填项', icon: 'none' })
      return
    }

    // 拼房型：Studio 直接存 Studio，否则存 xBxB
    let room_type = ''
    const bedroom = d.bedrooms[d.bedroomIndex]
    const bathroom = d.bathrooms[d.bathroomIndex]
    if (bedroom === 'Studio') {
      room_type = 'Studio'
    } else {
      room_type = bedroom + 'B' + bathroom + 'B'
    }

    wx.showLoading({ title: '发布中...' })

    // 文字先过内容安全检测，违规就不用传图了
    if (!(await ensureContentOk({
      texts: [d.title, d.address, d.roommate_info, d.description, d.contact_wechat]
    }))) return

    try {
      const imageUrls = []
      for (let i = 0; i < d.images.length; i++) {
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: 'sublet/' + Date.now() + '_' + i + '.jpg',
          filePath: d.images[i]
        })
        imageUrls.push(uploadRes.fileID)
      }

      // 图片也要过检测，没过就把刚传上去的清掉
      if (!(await ensureContentOk({ fileIDs: imageUrls }))) {
        await deleteCloudFiles(imageUrls)
        return
      }

      const db = wx.cloud.database()
      await db.collection('sublet_items').add({
        data: {
          title: d.title,
          rent: Number(d.rent),
          address: d.address,
          contact_wechat: d.contact_wechat,
          start_date: d.start_date,
          end_date: d.end_date,
          room_type: room_type,
          furnished: d.furnished,
          utilities: d.utilities ? Number(d.utilities) : null,
          deposit: d.deposit ? Number(d.deposit) : null,
          roommate_info: d.roommate_info,
          description: d.description,
          images: imageUrls,
          kind: this.data.kind,     // offer / seek，决定它出现在找房页的哪一面
          status: 'on_sale',
          created_at: new Date()
        }
      })

      wx.hideLoading()
      markStale('sublet')   // 列表页返回时会看到这条新发布的
      wx.showToast({ title: '发布成功！', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)
    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})