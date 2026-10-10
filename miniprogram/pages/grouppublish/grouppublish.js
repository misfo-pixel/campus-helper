const { markStale } = require('../../utils/refresh.js')
const { myProfile } = require('../../utils/user.js')
const { createUploader, requestReview } = require('../../utils/publish.js')
const { ask } = require('../../utils/subscribe.js')
const { KINDS } = require('../../utils/kinds.js')
const { today } = require('../../utils/date.js')

const CFG = KINDS.group
const MAX_IMAGES = 3   // 群组靠文字说清楚，图只是封面或活动海报，用不着 6 张

Page({
  data: {
    kind: CFG.default,   // buddy = 找搭子（一次性），club = 长期群
    kinds: CFG.tabs,
    images: [],
    maxImages: MAX_IMAGES,
    title: '',
    description: '',
    contact_wechat: '',
    event_date: '',
    location: '',
    today: today()
  },

  // 微信号自动填个人资料里存的那个，没存过就留空手填
  onLoad: function () {
    // 选图即上传：选完就在后台传，点发布时多半已经传完（见 utils/publish.js）
    this.uploader = createUploader('group')

    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      if (profile.wechat && !this.data.contact_wechat) {
        this.setData({ contact_wechat: profile.wechat })
      }
    }).catch(err => {
      console.error('读取微信号失败：', err)
    })
  },

  // 没发布就走了，后台已经传上去的图要清掉。发布成功的已经 commit 过，这里什么都不删
  onUnload: function () {
    this.uploader.discard()
  },

  onTapKind: function (e) {
    this.setData({ kind: e.currentTarget.dataset.key })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onDateChange: function (e) {
    this.setData({ event_date: e.detail.value })
  },

  removeImage: function (e) {
    const images = this.data.images.slice()
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ images: images })
    this.uploader.sync(images)
  },

  chooseImages: function () {
    wx.chooseMedia({
      count: MAX_IMAGES - this.data.images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],   // 压缩版才能过 imgSecCheck 的 1MB 上限
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({ images: this.data.images.concat(newImages) })
        this.uploader.sync(this.data.images)
      }
    })
  },

  submitPublish: async function () {
    const d = this.data
    if (!d.title || !d.description || !d.contact_wechat) {
      wx.showToast({ title: '请填完必填项', icon: 'none' })
      return
    }
    const buddy = d.kind === 'buddy'

    // 订阅授权必须在第一个 await 之前弹，理由见 taskpublish。inquiry：有人留言时通知群主
    ask('inquiry')

    wx.showLoading({ title: '发布中...', mask: true })

    try {
      const up = await this.uploader.collect(d.images)

      // 以「审核中」写库，审核通过之前列表里看不到
      const db = wx.cloud.database()
      const added = await db.collection('group_items').add({
        data: {
          kind: d.kind,
          title: d.title,
          description: d.description,
          contact_wechat: d.contact_wechat,
          // 长期群没有日期和地点。切过面再切回来，输入框里的字还留在 data 上，这里不能照抄
          event_date: buddy ? d.event_date : '',   // autoExpire 过了这天就下架，空串不下架
          location: buddy ? d.location : '',
          images: up.images,
          thumb: up.thumb,
          status: 'reviewing',
          created_at: new Date()
        }
      })
      this.uploader.commit()

      requestReview('group', added._id, d.title)

      wx.hideLoading()
      markStale('group')
      wx.showToast({ title: '已提交，审核中', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)
    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})
