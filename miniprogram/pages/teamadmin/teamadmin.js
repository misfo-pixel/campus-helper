// 配送队管理（超管 / 运营管理员）。
//
// 两件事：发开队码（建队的门槛），以及下架 / 恢复队伍。
// 权限在 deliveryManage 的 isTeamAdmin 里服务端校验，前端这层只是入口。

const { formatTime } = require('../../utils/date.js')

const TAKEDOWN_TEXT = { report: '被举报', no_show: '爽约过多', admin: '手动' }

function codeState(c) {
  if (c.used) return c.team_name ? '已用于「' + c.team_name + '」' : '已使用'
  if (new Date(c.expires_at) < new Date()) return '已过期'
  return '未使用 · ' + formatTime(c.expires_at) + ' 过期'
}

Page({
  data: {
    loading: true,
    loadError: false,
    codes: [],
    teams: [],
    busy: false
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'adminOverview' }
    }).then(res => {
      if (done) done()
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false, loadError: true })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      this.setData({
        loading: false,
        loadError: false,
        codes: (r.codes || []).map(c => Object.assign({}, c, {
          stateText: codeState(c),
          live: !c.used && new Date(c.expires_at) >= new Date()
        })),
        teams: (r.teams || []).map(t => Object.assign({}, t, {
          downText: t.takedown ? '已下架 · ' + (TAKEDOWN_TEXT[t.takedown_reason] || '手动') : ''
        }))
      })
    }).catch(err => {
      if (done) done()
      console.error('读取配送队管理失败：', err)
      this.setData({ loading: false, loadError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  retry: function () {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  makeCode: function () {
    if (this.data.busy) return
    wx.showModal({
      title: '生成开队码',
      editable: true,
      placeholderText: '给谁的（选填）',
      success: res => {
        if (!res.confirm) return
        this.setData({ busy: true })
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'makeCreateCode', note: res.content || '' }
        }).then(r => {
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: result.message || '生成失败', icon: 'none' })
            return
          }
          this.load()
          wx.showModal({
            title: result.code,
            content: '一码建一支队，7 天内有效。发给对方，在「我的配送 → 创建配送队」里填。',
            confirmText: '复制',
            showCancel: false,
            success: () => this.copy(result.code)
          })
        }).catch(err => {
          console.error('生成开队码失败：', err)
          wx.showToast({ title: '生成失败', icon: 'none' })
        }).then(() => {
          this.setData({ busy: false })
        })
      }
    })
  },

  copyCode: function (e) {
    this.copy(e.currentTarget.dataset.code)
  },

  copy: function (text) {
    if (!text) return
    wx.setClipboardData({ data: text })
  },

  toggleTakedown: function (e) {
    const { id, name, down } = e.currentTarget.dataset
    const takedown = !down
    wx.showModal({
      title: (takedown ? '下架' : '恢复') + '「' + name + '」？',
      content: takedown
        ? '下架后不出现在挑队列表、收不到群发、接不了新单，手上已接的单还能送完。'
        : '恢复后爽约次数清零，重新出现在挑队列表里。',
      confirmText: takedown ? '下架' : '恢复',
      confirmColor: takedown ? '#C8102E' : '#7A0019',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'setTakedown', teamId: id, takedown: takedown }
        }).then(r => {
          const result = (r && r.result) || {}
          wx.showToast({ title: result.success ? '已' + (takedown ? '下架' : '恢复') : (result.message || '操作失败'), icon: 'none' })
          if (result.success) this.load()
        }).catch(err => {
          console.error('下架 / 恢复失败：', err)
          wx.showToast({ title: '操作失败', icon: 'none' })
        })
      }
    })
  }
})
