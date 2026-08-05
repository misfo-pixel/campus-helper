const { fetchMyProfile } = require('../../utils/user.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

Page({
  data: {
    nickname: '',
    wechat: '',
    avatarUrl: '',   // 显示用：可能是云文件 ID，也可能是刚选完的本地临时路径
    tempAvatar: '',  // 本次新选的本地文件，点保存时才上传
    saving: false
  },

  onLoad: function () {
    // 读取当前用户已有信息，预填
    fetchMyProfile().then(profile => {
      this.setData({
        nickname: profile.nickname,
        wechat: profile.wechat,
        avatarUrl: profile.avatarUrl
      })
    }).catch(err => {
      console.error('加载个人资料失败：', err)
    })
  },

  onChooseAvatar: function (e) {
    // 微信给的是本地临时文件，先只做预览
    this.setData({
      avatarUrl: e.detail.avatarUrl,
      tempAvatar: e.detail.avatarUrl
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  save: async function () {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中', mask: true })

    try {
      // 昵称和微信号会展示给别的同学看，属于 UGC，要过内容安全检测
      if (!(await ensureContentOk({
        texts: [this.data.nickname, this.data.wechat],
        scene: 1
      }))) return

      const avatarUrl = await this.uploadAvatar()

      // 只有这次换了新头像才需要检测；没换的话是之前已经检过的云文件
      if (this.data.tempAvatar && avatarUrl) {
        if (!(await ensureContentOk({ fileIDs: [avatarUrl], scene: 1 }))) {
          await deleteCloudFiles([avatarUrl])
          return
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'updateUserInfo',
        data: {
          nickname: this.data.nickname,
          wechat: this.data.wechat,
          avatarUrl: avatarUrl
        }
      })

      wx.hideLoading()
      if (res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 1000)
      } else {
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    } catch (err) {
      console.error('保存资料失败：', err)
      wx.hideLoading()
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 没换头像就把原来的云文件 ID 原样传回去
  uploadAvatar: function () {
    const temp = this.data.tempAvatar
    if (!temp) return Promise.resolve(this.data.avatarUrl)

    const match = temp.match(/\.(\w+)$/)
    const ext = match ? match[1] : 'png'
    const cloudPath = 'avatars/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
    return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: temp }).then(r => r.fileID)
  }
})
