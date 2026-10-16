// 在电脑上管理小店：生成网页登录码（流程见 cloudfunctions/shopManage 的「网页登录」）。
// 店长在 minnepal.com/shop 输入这个码，网页就登进他自己的店，之后 7 天不用再输。
const { t, f, getLang } = require('../../i18n/index.js')

// 网页有中英两版，按小程序当前语言给对应的网址
const webUrl = () => (getLang() === 'en' ? 'minnepal.com/en/shop' : 'minnepal.com/shop')

Page({
  data: {
    stage: 'starting',     // starting / ready / expired
    code: '',
    codeText: '',          // 'K7M4 QXPA'，分两段好念
    minutes: 5,
    url: webUrl()
  },

  onLoad: function () {
    this.start()
  },

  onUnload: function () {
    clearTimeout(this.timer)
  },

  start: function () {
    this.setData({ stage: 'starting' })
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'webLoginStart' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '生成失败'), icon: 'none' })
        return
      }
      const ms = Math.max(0, r.expiresAt - Date.now())
      this.setData({
        stage: 'ready',
        code: r.code,
        codeText: r.code.slice(0, 4) + ' ' + r.code.slice(4),
        minutes: Math.max(1, Math.round(ms / 60000))
      })
      // 只是把码划掉提示过期，真正的有效期以云函数为准
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.setData({ stage: 'expired' }), ms)
    }).catch(err => {
      console.error('生成网页登录码失败：', err)
      wx.showToast({ title: t('生成失败，请重试'), icon: 'none' })
    })
  },

  copyUrl: function () {
    wx.setClipboardData({ data: 'https://' + this.data.url })
  },

  copyCode: function () {
    if (this.data.stage === 'ready') wx.setClipboardData({ data: this.data.code })
  },

  // 换了电脑、在别人电脑上登过：一键让所有网页登录失效
  logoutAll: function () {
    wx.showModal({
      title: t('退出所有网页登录'),
      content: t('所有登录过的电脑都要重新输入登录码。'),
      confirmText: t('退出'),
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({ name: 'shopManage', data: { action: 'webLogoutAll' } }).then(r => {
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: t(result.message || '操作失败'), icon: 'none' })
            return
          }
          wx.showToast({ title: f('已退出 {0} 处登录', result.count || 0), icon: 'none' })
        }).catch(err => {
          console.error('退出网页登录失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  }
})
