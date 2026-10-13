const { myProfile, readCachedProfile, writeCachedProfile } = require('../../utils/user.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

Page({
  data: {
    nickname: '',
    wechat: '',
    avatarUrl: '',   // 显示用：可能是云文件 ID，也可能是刚选完的本地临时路径
    tempAvatar: '',  // 本次新选的本地文件，点保存时才上传
    saving: false,

    email: '',
    emailVerified: false,
    isStudent: false,
    changingEmail: false,
    emailInput: '',
    code: '',
    codeSent: false,
    countdown: 0
  },

  onLoad: function (options) {
    // 从下单/发布被拦过来的（?verify=1），验证完自动返回原页，表单还在
    this.backAfterVerify = options && options.verify === '1'
    // 读取当前用户已有信息，预填
    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      this.setData({
        nickname: profile.nickname,
        wechat: profile.wechat,
        avatarUrl: profile.avatarUrl,
        email: profile.email || '',
        emailVerified: !!profile.emailVerified,
        isStudent: !!profile.isStudent
      })
    }).catch(err => {
      console.error('加载个人资料失败：', err)
    })
  },

  onUnload: function () {
    clearInterval(this.timer)
  },

  changeEmail: function () {
    this.setData({ changingEmail: true, emailInput: '', code: '', codeSent: false })
  },

  sendCode: async function () {
    if (this.data.countdown || this.sending) return
    const email = this.data.emailInput.trim().toLowerCase()
    // 和 emailVerify 的 STUDENT_RE 同一条规则，服务端那边才是闸门
    if (!/@(?:[a-z0-9-]+\.)+edu(?:\.[a-z]{2})?$/i.test(email)) {
      wx.showToast({ title: '请使用学校邮箱（.edu）', icon: 'none' })
      return
    }
    this.sending = true
    wx.showLoading({ title: '发送中', mask: true })
    try {
      const res = await wx.cloud.callFunction({ name: 'emailVerify', data: { action: 'send', email: email } })
      const r = (res && res.result) || {}
      wx.hideLoading()
      if (!r.success) {
        wx.showToast({ title: r.message || '发送失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已发送，看看邮箱', icon: 'none' })
      this.setData({ codeSent: true, countdown: 60 })
      clearInterval(this.timer)
      this.timer = setInterval(() => {
        const left = this.data.countdown - 1
        this.setData({ countdown: Math.max(left, 0) })
        if (left <= 0) clearInterval(this.timer)
      }, 1000)
    } catch (err) {
      console.error('发送验证码失败：', err)
      wx.hideLoading()
      wx.showToast({ title: '发送失败，请重试', icon: 'none' })
    } finally {
      this.sending = false
    }
  },

  verifyCode: async function () {
    if (this.verifying) return
    const email = this.data.emailInput.trim().toLowerCase()
    if (!/^\d{6}$/.test(this.data.code)) {
      wx.showToast({ title: '请填写 6 位验证码', icon: 'none' })
      return
    }
    this.verifying = true
    wx.showLoading({ title: '验证中', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'emailVerify',
        data: { action: 'verify', email: email, code: this.data.code }
      })
      const r = (res && res.result) || {}
      wx.hideLoading()
      if (!r.success) {
        wx.showToast({ title: r.message || '验证失败', icon: 'none' })
        return
      }

      // 和保存资料一样，本地缓存同步改掉，下单/发布那边的检查读的就是它
      const cached = readCachedProfile() || {}
      cached.email = r.email
      cached.emailVerified = true
      cached.isStudent = !!r.isStudent
      writeCachedProfile(cached)
      const app = getApp()
      if (app.globalData) app.globalData.profile = cached

      clearInterval(this.timer)
      this.setData({
        email: r.email, emailVerified: true, isStudent: !!r.isStudent,
        changingEmail: false, code: '', codeSent: false, countdown: 0
      })
      wx.showToast({ title: '验证成功', icon: 'success' })
      if (this.backAfterVerify) setTimeout(() => wx.navigateBack(), 1000)
    } catch (err) {
      console.error('验证邮箱失败：', err)
      wx.hideLoading()
      wx.showToast({ title: '验证失败，请重试', icon: 'none' })
    } finally {
      this.verifying = false
    }
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
        // 服务端存好了，本地那份缓存也得同步更新。
        // 不更新的话，下次打开小程序会先闪一下旧昵称旧头像，
        // 等后台刷新回来才跳成新的——缓存最常见的坑就是写完忘了失效。
        const cached = readCachedProfile() || {}
        cached.nickname = this.data.nickname
        cached.wechat = this.data.wechat
        cached.avatarUrl = avatarUrl
        writeCachedProfile(cached)
        const app = getApp()
        if (app.globalData) app.globalData.profile = cached

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
