// pages/publish.js
const { fetchMyProfile } = require('../../utils/user.js')

Page({
  data: {
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
    fetchMyProfile().then(profile => {
      if (profile.wechat && !this.data.seller_wechat) {
        this.setData({ seller_wechat: profile.wechat, wechatAutoFilled: true })
      }
    }).catch(err => {
      console.error('读取微信号失败：', err)
    })
  },

  // 通用输入处理（用 data-field 区分是哪个输入框）
  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onDateChange: function (e) {
    this.setData({ expire_date: e.detail.value })
  },

  // 选图片（可多选）
  chooseImages: function () {
    wx.chooseMedia({
      count: 6 - this.data.images.length,  // 最多6张
      mediaType: ['image'],
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({
          images: this.data.images.concat(newImages)  // 追加到已有的
        })
      }
    })
  },

  // 发布
  submitPublish: async function () {
    const { title, price, description, seller_wechat, expire_date, images } = this.data

    // 校验
    if (!title || !price || !seller_wechat) {
      wx.showToast({ title: '请填完整信息', icon: 'none' })
      return
    }
    if (images.length === 0) {
      wx.showToast({ title: '请上传图片', icon: 'none' })
      return
    }

    wx.showLoading({ title: '发布中...' })

    try {
      // 1. 先把所有图片上传到云存储，收集它们的 fileID
      const imageUrls = []
      for (let i = 0; i < images.length; i++) {
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: 'secondhand/' + Date.now() + '_' + i + '.jpg',
          filePath: images[i]
        })
        imageUrls.push(uploadRes.fileID)
      }

      // 2. 把商品信息写进数据库
      const db = wx.cloud.database()
      await db.collection('secondhand_items').add({
        data: {
          title: title,
          price: Number(price),
          description: description,
          images: imageUrls,       // 存的是所有图片地址的数组
          seller_wechat: seller_wechat,
          expire_date: expire_date,
          status: 'on_sale',
          created_at: new Date()
        }
      })

      wx.hideLoading()
      wx.showToast({ title: '发布成功！', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)  // 发布后返回上一页

    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})