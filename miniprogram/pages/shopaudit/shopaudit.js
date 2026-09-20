// 配送队核对（超管 / 饭搭子管理员）。
//
// 商家那一半已经拆掉了：平台不做事前审核，商家提交即开店，违规走
// 「用户举报 → 人工复核 → 强制下架」那条线（submitReport / handleReport）。
//
// 配送队留着核对，因为它不是内容问题：队伍会拿到别人的订单、买家的联系方式，
// 还要跟商家对账收钱。谁能站到这个位置上，得有一道门。

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    status: 'pending',
    teams: [],
    loading: true
  },

  onShow: function () {
    this.load()
  },

  switchStatus: function (e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.status) return
    this.setData({ status: status, teams: [], loading: true }, () => this.load())
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'listForAudit', status: this.data.status }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      this.setData({
        teams: (r.teams || []).map(t => Object.assign({}, t, { timeText: formatTime(t.created_at) })),
        loading: false
      })
    }).catch(err => {
      console.error('读取待审队伍失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  approveTeam: function (e) {
    this.handleTeam(e.currentTarget.dataset.id, true, '')
  },

  rejectTeam: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '驳回队伍',
      editable: true,
      placeholderText: '填写驳回原因，队长能看到',
      success: res => {
        if (res.confirm) this.handleTeam(id, false, res.content || '')
      }
    })
  },

  handleTeam: function (teamId, approve, reason) {
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'audit', teamId: teamId, approve: approve, reason: reason }
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
      console.error('审核队伍失败：', err)
      wx.showToast({ title: '处理失败', icon: 'none' })
    })
  }
})
