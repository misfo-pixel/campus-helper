// 开店码（超管 / 运营管理员）。一码开一家店，7 天内有效。
// 和配送管理里的开队码是同一套做法；权限在 shopManage 的 isShopAdmin 里服务端校验，
// 前端这层只是入口。

const { formatTime } = require('../../utils/date.js')
const { t, f } = require('../../i18n/index.js')

function codeState(c) {
  if (c.used) return c.shop_name ? f('已用于「{0}」', c.shop_name) : t('已使用')
  if (new Date(c.expires_at) < new Date()) return t('已过期')
  return f('{0} 过期', formatTime(c.expires_at))
}

Page({
  data: {
    loading: true,
    codes: [],
    busy: false
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'listShopCodes' } }).then(res => {
      if (done) done()
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
        return
      }
      this.setData({
        loading: false,
        codes: (r.codes || []).map(c => Object.assign({}, c, {
          stateText: codeState(c),
          live: !c.used && new Date(c.expires_at) >= new Date()
        }))
      })
    }).catch(err => {
      if (done) done()
      console.error('读取开店码失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  makeCode: function () {
    if (this.data.busy) return
    wx.showModal({
      title: t('生成开店码'),
      editable: true,
      placeholderText: t('给谁的（选填）'),
      success: res => {
        if (!res.confirm) return
        this.setData({ busy: true })
        wx.cloud.callFunction({
          name: 'shopManage',
          data: { action: 'makeShopCode', note: res.content || '' }
        }).then(r => {
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: t(result.message || '生成失败'), icon: 'none' })
            return
          }
          this.load()
          wx.showModal({
            title: t(result.code),
            content: t('一码开一家店，7 天内有效。'),
            confirmText: t('复制'),
            showCancel: false,
            success: () => wx.setClipboardData({ data: result.code })
          })
        }).catch(err => {
          console.error('生成开店码失败：', err)
          wx.showToast({ title: t('生成失败'), icon: 'none' })
        }).then(() => {
          this.setData({ busy: false })
        })
      }
    })
  },

  copyCode: function (e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.setClipboardData({ data: code })
  }
})
