// 举报处理台（管理员）。
// 有这个页面，提审时才说得出「举报有人工复核」这句话。
// 权限在 getReports / handleReport 两个云函数里服务端校验，前端这层只是入口。

const TYPE_TEXT = { item: '闲置', sublet: '转租', task: '委托', group: '群组', shop: '店铺', team: '配送队', message: '留言' }
// 店铺和配送队只下架不删（底下挂着订单 / 请求），按钮和结果都说「下架」
const TAKEDOWN_TYPES = ['shop', 'team']

const { ask } = require('../../utils/subscribe.js')
const { formatTime } = require('../../utils/date.js')

Page({
  data: {
    reports: [],
    status: 'pending',
    loading: true
  },

  onShow: function () {
    // 管理员每来一次就要一次授权，攒的额度供第二天的每日汇总用
    ask('adminPending')
    this.load()
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
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
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
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 删除被举报的内容
  removeContent: function (e) {
    const { id, takedown } = e.currentTarget.dataset
    wx.showModal({
      title: takedown ? '下架' : '删除内容',
      content: takedown
        ? '下架后不再对外展示，记录保留。配送队可在「配送队管理」里恢复。确定吗？'
        : '会把这条被举报的内容从市场里删掉，无法恢复。确定吗？',
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
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'handleReport',
      data: { reportId: reportId, action: action }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已处理', icon: 'success' })
        this.load()
      } else {
        wx.showToast({ title: r.message || '处理失败', icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('处理举报失败：', err)
      wx.showToast({ title: '处理失败', icon: 'none' })
    })
  }
})
