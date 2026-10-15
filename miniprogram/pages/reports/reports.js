// 举报处理台（管理员）。
// 有这个页面，提审时才说得出「举报有人工复核」这句话。
// 权限在 getReports / handleReport 两个云函数里服务端校验，前端这层只是入口。

const TYPE_TEXT = { item: t('闲置'), sublet: t('转租'), task: t('委托'), group: t('群组'), shop: t('店铺'), team: t('配送队'), message: t('留言') }
// 店铺和配送队只下架不删（底下挂着订单 / 请求），按钮和结果都说「下架」
const TAKEDOWN_TYPES = ['shop', 'team']

const { askOrGuide } = require('../../utils/subscribe.js')
const { formatTime } = require('../../utils/date.js')
const { t } = require('../../i18n/index.js')

Page({
  data: {
    reports: [],
    status: 'pending',
    loading: true
  },

  onShow: function () {
    this.load()
  },

  // 每日待处理汇总（adminDigest）要的授权。微信只认用户点按钮时弹的授权，
  // 原来写在 onShow 里自动要，每次都静默失败，管理员一张票都攒不到，所以从来收不到。
  // 点一次 = 一张票 = 收一次汇总
  askDigest: function () {
    askOrGuide('adminPending').then(ok => {
      if (ok) wx.showToast({ title: t('下次有待处理会提醒你'), icon: 'none' })
    })
  },

  switchStatus: function (e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.status) return
    this.setData({ status: status, reports: [], loading: true }, () => this.load())
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'getReports',
      data: { status: this.data.status }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: t(r.message || t('读取失败')), icon: 'none' })
        return
      }
      const reports = (r.reports || []).map(item => Object.assign({}, item, {
        typeText: TYPE_TEXT[item.targetType] || item.targetType,
        takedownOnly: TAKEDOWN_TYPES.indexOf(item.targetType) >= 0,
        timeText: formatTime(item.created_at)
      }))
      this.setData({ reports: reports, loading: false })
    }).catch(err => {
      console.error('读取举报列表失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  // 删除被举报的内容
  removeContent: function (e) {
    const { id, takedown } = e.currentTarget.dataset
    wx.showModal({
      title: t(takedown ? t('下架') : t('删除内容')),
      content: t(takedown
        ? t('下架后不再对外展示，记录保留。配送队可在「配送队管理」里恢复。确定吗？')
        : t('会把这条被举报的内容从市场里删掉，无法恢复。确定吗？')),
      success: res => {
        if (res.confirm) this.handle(id, 'delete')
      }
    })
  },

  // 判定不违规，驳回举报
  dismiss: function (e) {
    this.handle(e.currentTarget.dataset.id, 'dismiss')
  },

  handle: function (reportId, action) {
    wx.showLoading({ title: t('处理中'), mask: true })
    wx.cloud.callFunction({
      name: 'handleReport',
      data: { reportId: reportId, action: action }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: t('已处理'), icon: 'success' })
        this.load()
      } else {
        wx.showToast({ title: t(r.message || t('处理失败')), icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('处理举报失败：', err)
      wx.showToast({ title: t('处理失败'), icon: 'none' })
    })
  }
})
