// 商家入驻审核（超管）。
// 整个外卖模块只有这一处需要管理员，而且一家店一辈子审一次。
// 日常订单流转完全不经过这里。

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    kind: 'shop',      // shop 商家 | team 配送队
    status: 'pending',
    shops: [],
    teams: [],
    loading: true
  },

  switchKind: function (e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === this.data.kind) return
    this.setData({ kind: kind, shops: [], teams: [], status: 'pending', loading: true }, () => this.load())
  },

  onShow: function () {
    this.load()
  },

  switchStatus: function (e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.status) return
    this.setData({ status: status, shops: [], teams: [], loading: true }, () => this.load())
  },

  load: function () {
    return this.data.kind === 'team' ? this.loadTeams() : this.loadShops()
  },

  loadTeams: function () {
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
  },

  loadShops: function () {
    wx.cloud.callFunction({
      name: 'auditShop',
      data: { action: 'list', status: this.data.status }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      const shops = (r.shops || []).map(s => Object.assign({}, s, {
        timeText: formatTime(s.created_at)
      }))
      this.setData({ shops: shops, loading: false })
    }).catch(err => {
      console.error('读取待审店铺失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  approve: function (e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '核对通过',
      content: '确认「' + name + '」填写的信息完整、看起来是真实的？通过后该店即可营业。\n\n' +
               '这一步只是核对信息填得全不全，不是对该商家的经营资质、食品安全或菜品质量做任何检查或认可。' +
               '这些由商家自己负责，他们在入驻时已书面承诺。',
      success: res => {
        if (res.confirm) this.handle('approve', id)
      }
    })
  },

  reject: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '驳回',
      editable: true,
      placeholderText: '填写驳回原因，商家能看到',
      success: res => {
        if (res.confirm) this.handle('reject', id, res.content || '')
      }
    })
  },

  handle: function (action, shopId, reason) {
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'auditShop',
      data: { action: action, shopId: shopId, reason: reason || '' }
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
      console.error('审核失败：', err)
      wx.showToast({ title: '处理失败', icon: 'none' })
    })
  }
})
