const { markStale } = require('../../utils/refresh.js')
const { myProfile } = require('../../utils/user.js')
const { createUploader, requestReview } = require('../../utils/publish.js')

Page({
  data: {
    images: [],
    title: '',
    reward: '',
    description: '',
    contact_wechat: '',
    deadline: '',
    location: '',
    wechatAutoFilled: false
  },

  // 微信号自动填个人资料里存的那个，没存过就留空手填
  onLoad: function () {
    // 选图即上传：选完就在后台传，点发布时多半已经传完（见 utils/publish.js）
    this.uploader = createUploader('task')

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

  onDeadlineChange: function (e) {
    this.setData({ deadline: e.detail.value })
  },

  submitPublish: async function () {
    const d = this.data
    // 必填校验：title, reward, description, contact_wechat
    if (!d.title || !d.reward || !d.description || !d.contact_wechat) {
      wx.showToast({ title: '请填完必填项', icon: 'none' })
      return
    }

    wx.showLoading({ title: '发布中...', mask: true })   // 挡住连点和发布途中删图

    try {
      // 拿图片的 fileID。选图时就开始在后台传了，这里多半直接拿到
      const up = await this.uploader.collect(d.images)

      // 以「审核中」写库。任务列表只查 open，审核通过之前别人看不到
      const db = wx.cloud.database()
      const added = await db.collection('task_items').add({
        data: {
          title: d.title,
          reward: Number(d.reward),
          description: d.description,
          contact_wechat: d.contact_wechat,
          deadline: d.deadline,
          location: d.location,
          images: up.images,
          thumb: up.thumb,          // 列表页只下载这张小图
          status: 'reviewing',
          created_at: new Date()
        }
      })
      this.uploader.commit()   // 图已经归这条帖子了，离开页面时别当成没用的删掉

      // 送审，不等结果。审核在服务端跑，没通过会弹窗告诉用户
      requestReview('task', added._id, d.title)

      wx.hideLoading()
      markStale('task')   // 列表页返回时会看到这条新发布的
      wx.showToast({ title: '已提交，审核中', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)
    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})