const { fetchMyProfile } = require('../../utils/user.js')

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
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath)
        this.setData({ images: this.data.images.concat(newImages) })
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

    wx.showLoading({ title: '发布中...' })
    try {
      const imageUrls = []
      for (let i = 0; i < d.images.length; i++) {
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: 'task/' + Date.now() + '_' + i + '.jpg',
          filePath: d.images[i]
        })
        imageUrls.push(uploadRes.fileID)
      }

      const db = wx.cloud.database()
      await db.collection('task_items').add({
        data: {
          title: d.title,
          reward: Number(d.reward),
          description: d.description,
          contact_wechat: d.contact_wechat,
          deadline: d.deadline,
          location: d.location,
          images: imageUrls,
          status: 'open',
          created_at: new Date()
        }
      })

      wx.hideLoading()
      wx.showToast({ title: '发布成功！', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1500)
    } catch (err) {
      wx.hideLoading()
      console.error('发布失败：', err)
      wx.showToast({ title: '发布失败', icon: 'none' })
    }
  }
})