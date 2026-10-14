// 已屏蔽的用户（见 utils/blocks.js、cloudfunctions/userBlock）。在这里取消屏蔽
const { t } = require('../../i18n/index.js')
const { refresh, blockedUsers, unblockUser } = require('../../utils/blocks.js')

Page({
  data: {
    users: [],
    loading: true
  },

  onLoad: function () {
    this.setData({ users: blockedUsers(), loading: blockedUsers().length === 0 })
    refresh()
      .then(m => this.setData({ users: m.users, loading: false }))
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: t('读取失败'), icon: 'none' })
      })
  },

  unblock: function (e) {
    const uid = e.currentTarget.dataset.uid
    wx.showLoading({ title: t('处理中'), mask: true })
    unblockUser(uid)
      .then(m => {
        wx.hideLoading()
        this.setData({ users: m.users })
        wx.showToast({ title: t('已取消屏蔽'), icon: 'success' })
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: t(err.message || '操作失败'), icon: 'none' })
      })
  }
})
