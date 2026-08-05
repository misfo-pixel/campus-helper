// 举报处理台（管理员）。
// 有这个页面，提审时才说得出「举报有人工复核」这句话。
// 权限在 getReports / handleReport 两个云函数里服务端校验，前端这层只是入口。

const TYPE_TEXT = { item: '闲置', sublet: '转租', task: '委托' }

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    reports: [],
    status: 'pending',
    loading: true
  },

  onShow: function () {
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
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除内容',
      content: '会把这条被举报的内容从市场里删掉，无法恢复。确定吗？',
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
