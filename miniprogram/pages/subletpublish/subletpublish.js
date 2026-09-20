const { markStale } = require('../../utils/refresh.js')
const { myProfile } = require('../../utils/user.js')
const { createUploader, requestReview } = require('../../utils/publish.js')
const { ask } = require('../../utils/subscribe.js')
const { KINDS, isDemand } = require('../../utils/kinds.js')

const CFG = KINDS.sublet
const BEDROOMS = ['Studio', '1', '2', '3', '4', '5+']
const BATHROOMS = ['1', '2', '3', '4+']
const ANY = '不限'

// 房型下拉选中的下标。存的下标始终对应 BEDROOMS / BATHROOMS 本身；
// 求租的下拉最前面多一个「不限」，所以要错开一位，选「不限」就等于没填（null）
function pickedIndex(e, demand) {
  const i = Number(e.detail.value)
  if (!demand) return i
  return i === 0 ? null : i - 1
}

// 房型：Studio 直接存 Studio，否则存 xBxB。
// 求租可以只选一项或都不选：只选一项写成「2 室」「1 卫」，都不选存空串，列表上显示「不限」
function roomType(d) {
  const bedroom = d.bedroomIndex === null ? null : d.bedrooms[d.bedroomIndex]
  const bathroom = d.bathroomIndex === null ? null : d.bathrooms[d.bathroomIndex]
  if (bedroom === 'Studio') return 'Studio'
  if (bedroom && bathroom) return bedroom + 'B' + bathroom + 'B'
  if (bedroom) return bedroom + ' 室'
  if (bathroom) return bathroom + ' 卫'
  return ''
}

Page({
  data: {
    kind: CFG.default,   // offer = 我要转租，seek = 我要找房
    kinds: CFG.tabs,
    demand: false,
    images: [],
    title: '',
    rent: '',            // 转租：月租
    rent_min: '',        // 求租：预算区间
    rent_max: '',
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
    bedrooms: BEDROOMS,
    bathrooms: BATHROOMS,
    bedroomsAny: [ANY].concat(BEDROOMS),     // 求租用
    bathroomsAny: [ANY].concat(BATHROOMS)
  },

  // 微信号自动填个人资料里存的那个，没存过就留空手填
  onLoad: function () {
    // 选图即上传：选完就在后台传，点发布时多半已经传完（见 utils/publish.js）
    this.uploader = createUploader('sublet')
    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      if (profile.wechat && !this.data.contact_wechat) {
        this.setData({ contact_wechat: profile.wechat, wechatAutoFilled: true })
      }
    }).catch(err => {
      console.error('读取微信号失败：', err)
    })
  },

  // 没发布就走了，后台已经传上去的图要清掉。发布成功的已经 commit 过，这里什么都不删
  onUnload: function () {
    this.uploader.discard()
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  // 删掉一张已选的图
  removeImage: function (e) {
    const images = this.data.images.slice()
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ images: images })
    this.uploader.sync(images)   // 删掉的那张如果已经传上去了，顺手清掉
  },

  chooseImages: function () {
    wx.chooseMedia({
      count: 6 - this.data.images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],   // 压缩版才能过 imgSecCheck 的 1MB 上限
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({ images: this.data.images.concat(newImages) })
        this.uploader.sync(this.data.images)   // 马上开始后台上传
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
    this.setData({ bedroomIndex: pickedIndex(e, this.data.demand) })
  },
  onBathroomChange: function (e) {
    this.setData({ bathroomIndex: pickedIndex(e, this.data.demand) })
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
    // 必填：标题、微信号、起止日期两边都要。
    // 转租另外要月租、地址、房型；求租要预算区间，区域和房型可以不填（「学校附近都行」很常见）
    const missing = d.demand
      ? !d.rent_min || !d.rent_max
      : !d.rent || !d.address || d.bedroomIndex === null || d.bathroomIndex === null
    if (!d.title || !d.contact_wechat || !d.start_date || !d.end_date || missing) {
      wx.showToast({ title: '请填完必填项', icon: 'none' })
      return
    }
    if (d.demand && Number(d.rent_min) > Number(d.rent_max)) {
      wx.showToast({ title: '最低预算不能高于最高预算', icon: 'none' })
      return
    }
    const room_type = roomType(d)

    wx.showLoading({ title: '发布中...', mask: true })   // 挡住连点和发布途中删图

    try {
      // 拿图片的 fileID。选图时就开始在后台传了，这里多半直接拿到
      const up = await this.uploader.collect(d.images)

      // 以「审核中」写库。找房页只查 on_sale，审核通过之前别人看不到
      const db = wx.cloud.database()
      const added = await db.collection('sublet_items').add({
        data: {
          title: d.title,
          // 转租存单个月租，求租存区间。读的时候统一走 utils/kinds.js 的 rentText
          rent: d.demand ? null : Number(d.rent),
          rent_min: d.demand ? Number(d.rent_min) : null,
          rent_max: d.demand ? Number(d.rent_max) : null,
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
          images: up.images,
          thumb: up.thumb,          // 列表页只下载这张小图
          kind: this.data.kind,     // offer / seek，决定它出现在找房页的哪一面
          status: 'reviewing',
          created_at: new Date()
        }
      })
      this.uploader.commit()   // 图已经归这条帖子了，离开页面时别当成没用的删掉

      // 送审，不等结果。审核在服务端跑，没通过会弹窗告诉用户
      requestReview('sublet', added._id, d.title)
      // 租期结束前一天 autoExpire 会来提醒一次，得先有这张票
      ask('expiring')

      wx.hideLoading()
      markStale('sublet')   // 列表页返回时会看到这条新发布的
      wx.showToast({ title: '已提交，审核中', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)
    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})