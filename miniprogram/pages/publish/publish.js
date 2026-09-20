const { markStale } = require('../../utils/refresh.js')
// pages/publish.js
const { myProfile } = require('../../utils/user.js')
const { createUploader, requestReview } = require('../../utils/publish.js')
const { KINDS, isDemand } = require('../../utils/kinds.js')

const CFG = KINDS.item

Page({
  data: {
    kind: CFG.default,   // sell = 我要卖，want = 我要收
    kinds: CFG.tabs,
    demand: false,       // 求购帖没有实物，不强制传图
    images: [],        // 已选的图片（本地临时路径）
    title: '',
    price: '',
    description: '',
    seller_wechat: '',
    expire_date: '',
    wechatAutoFilled: false
  },

  // 微信号自动填个人资料里存的那个，没存过就留空手填
  onLoad: function () {
    // 选图即上传：选完就在后台传，点发布时多半已经传完（见 utils/publish.js）
    this.uploader = createUploader('secondhand')
    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      if (profile.wechat && !this.data.seller_wechat) {
        this.setData({ seller_wechat: profile.wechat, wechatAutoFilled: true })
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
    const kind = e.currentTarget.dataset.key
    this.setData({ kind: kind, demand: isDemand(kind) })
  },

  // 通用输入处理（用 data-field 区分是哪个输入框）
  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onDateChange: function (e) {
    this.setData({ expire_date: e.detail.value })
  },

  // 删掉一张已选的图
  removeImage: function (e) {
    const images = this.data.images.slice()
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ images: images })
    this.uploader.sync(images)   // 删掉的那张如果已经传上去了，顺手清掉
  },

  // 选图片（可多选）
  chooseImages: function () {
    wx.chooseMedia({
      count: 6 - this.data.images.length,  // 最多6张
      mediaType: ['image'],
      sizeType: ['compressed'],   // 压缩版才能过 imgSecCheck 的 1MB 上限
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({
          images: this.data.images.concat(newImages)  // 追加到已有的
        })
        this.uploader.sync(this.data.images)   // 马上开始后台上传
      }
    })
  },

  // 继续发下一件：清掉这件商品本身的内容。
  // 卖/收、微信号、下架日期（多半就是离美日期）大概率跟上一件一样，留着不用重填
  resetForm: function () {
    this.setData({ images: [], title: '', price: '', description: '' })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  // 发布
  submitPublish: async function () {
    const { title, price, description, seller_wechat, expire_date, images } = this.data

    // 校验
    if (!title || !price || !seller_wechat) {
      wx.showToast({ title: '请填完整信息', icon: 'none' })
      return
    }
    // 求购是「我想要什么」，本来就没有实物可拍，不强制传图
    if (!this.data.demand && images.length === 0) {
      wx.showToast({ title: '请上传图片', icon: 'none' })
      return
    }

    wx.showLoading({ title: '发布中...', mask: true })   // 挡住连点和发布途中删图

    try {
      // 1. 拿图片的 fileID。选图时就开始在后台传了，这里多半直接拿到；没传完的等一等，失败过的重传
      const up = await this.uploader.collect(images)

      // 2. 以「审核中」写库。市场页只查 on_sale，审核通过之前别人看不到
      const db = wx.cloud.database()
      const added = await db.collection('secondhand_items').add({
        data: {
          title: title,
          price: Number(price),
          description: description,
          images: up.images,       // 存的是所有图片地址的数组
          thumb: up.thumb,         // 列表页只下载这张小图
          seller_wechat: seller_wechat,
          expire_date: expire_date,
          kind: this.data.kind,     // sell / want，决定它出现在市场页的哪一面
          status: 'reviewing',
          created_at: new Date()
        }
      })
      this.uploader.commit()   // 图已经归这条帖子了，离开页面时别当成没用的删掉

      // 3. 送审，不等结果。审核在服务端跑，没通过会弹窗告诉用户
      requestReview('item', added._id, title)

      wx.hideLoading()
      markStale('item')   // 列表页返回时会看到这条新发布的
      // 搬家清仓常常一次要发好几件，问一句，省得每件都退回列表再点进来
      wx.showModal({
        title: '已提交，审核通过后自动公开',
        content: this.data.demand ? '还有别的想收吗？' : '还有别的闲置要一起发吗？',
        confirmText: '继续发布',
        cancelText: '返回',
        success: (res) => {
          if (res.confirm) {
            this.resetForm()
          } else {
            wx.navigateBack()
          }
        }
      })

    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})