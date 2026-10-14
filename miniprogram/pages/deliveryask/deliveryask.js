// 找配送队。店长在这儿把一趟配送发给校园配送队，也在这儿看进度和送达照片。
//（2026-10-10 前叫「配送状态」，名字说不清这页是干什么的，改了。）
//
// 这是配送队体系精简后店长侧的全部。原来那套（外包给队伍 → 买家按队伍的
// 方案下单 → 队伍按批次领活 → 配送费三态对账）代码还在，但不走了：
// 现阶段没有真实的配送队，那套工作流服务的是一个不存在的角色。
//
// 平台在这里只做三件事：把请求记下来、给队长发提醒、存一份送达照片。
// 送不送、给多少钱、怎么结，全是他们俩的事。
//
// 队伍多于一支时可以「发给所有队」，先接先得（规则在 deliveryRequest 云函数里）。
//
// 店长这里什么数都不填（2026-10-10 改）：几点出发、各点约几点到读小店设置，
// 每个点几单按这一场的订单数，钱按小店设置的配送费算。发出去以后单数还跟着
// 订单变，送达时定格。算法都在 deliveryRequest 云函数里，这页只管显示。

// teamIndex 取这个值表示群发
const ALL_TEAMS = -1

// 群发的还没人接时说「等待接单」，都拒了说「没人接」，其余和点名发的一样
function statusText(q) {
  if (q.broadcast && q.status === 'open') return t('等待接单')
  if (q.broadcast && q.status === 'declined') return t('没人接')
  if (q.released) return t('队伍退单')
  return t(STATUS_TEXT[q.status] || q.status)
}

const STATUS_TEXT = {
  open: '等队长联系',
  accepted: '配送中',
  delivered: '已送达',
  declined: '队长没接',
  no_show: '没来送'
}

// 举报配送队的原因，排第一的就是这页最常见的那种
const TEAM_REPORT_REASONS = ['接了单没来送', '骚扰 / 态度恶劣', '虚假信息 / 诈骗', '其他']

const { formatTime } = require('../../utils/date.js')
const { ask } = require('../../utils/subscribe.js')
const { money, departText, describe } = require('../../utils/delivery.js')
const { t, f } = require('../../i18n/index.js')

Page({
  data: {
    loading: true,
    teamsError: false,     // 读队伍列表失败：不能显示成「平台上还没有配送队」
    requestsError: false,  // 读配送记录失败：不能显示成「你还没发过配送请求」
    teams: [],
    teamIndex: null,
    note: '',
    sending: false,
    requests: [],

    // 这一场送哪、几单。云函数 preview 算好给的
    shopReady: false,
    noDelivery: false,     // 小店设置的是无需线下交付
    expired: false,        // 没有开着的服务时间
    departText: '',        // '10-19 周日 12:00 出发'
    lines: [],             // [{ name, arrive, count, feeText }]
    totalText: '',
    freeWarn: ''           // 有单的点配送费是 0
  },

  onShow: function () {
    this.loadPreview()
    this.loadTeams()
    this.loadRequests()
  },

  // 从设置页改完时间或配送费回来会再走 onShow，这里跟着刷新
  loadPreview: function (done) {
    wx.cloud.callFunction({ name: 'deliveryRequest', data: { action: 'preview' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) return
      const lines = (r.lines || []).map(l => Object.assign({}, l, { feeText: money(l.fee) }))
      const free = lines.find(l => l.fee <= 0)
      this.setData({
        shopReady: true,
        noDelivery: r.noDelivery === true,
        expired: r.expired === true,
        departText: r.batch ? departText(r.batch.date, r.batch.depart_time) : '',
        lines: lines,
        totalText: lines.length ? money(r.total) : '',
        freeWarn: free ? ((r.exact ? t('配送费是 $0，配送队拿不到钱，先去小店设置填上') : f('「{0}」的配送费是 $0，配送队拿不到钱，先去小店设置填上', free.name))) : ''
      })
    }).catch(err => {
      console.error('读取这一场的订单失败：', err)
    }).then(() => {
      if (done) done()
    })
  },

  goToShopSettings: function () {
    wx.navigateTo({ url: '/pages/shopedit/shopedit' })
  },

  onPullDownRefresh: function () {
    this.loadPreview()
    this.loadRequests(() => wx.stopPullDownRefresh())
  },

  retry: function () {
    this.setData({ loading: true, teamsError: false, requestsError: false })
    this.loadTeams()
    this.loadRequests()
  },

  // 读失败降级成空列表，页面会说「目前还没有配送队」——
  // 店长照这句话理解就是「平台上没有队」，其实是根本没读到。
  loadTeams: function () {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'listTeams' }
    }).then(res => {
      const r = (res && res.result) || {}

      if (!r.success) {
        this.setData({ loading: false, teamsError: true })
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
        return
      }

      const teams = (r.teams || []).map(team => Object.assign({}, team, {
        repText: (team.delivered_count || team.no_show_count)
          ? f('送达 {0} 单', team.delivered_count || 0) + (team.no_show_count ? f(' · 爽约 {0} 次', team.no_show_count) : '')
          : t('新队伍，还没送过')
      }))
      this.setData({ teams: teams, loading: false, teamsError: false })
    }).catch(err => {
      console.error('读取配送队失败：', err)
      this.setData({ loading: false, teamsError: true })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  loadRequests: function (done) {
    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: { action: 'listForShop' }
    }).then(res => {
      const r = (res && res.result) || {}

      if (!r.success) {
        this.setData({ requestsError: true })
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
        if (done) done()
        return
      }

      this.setData({
        requestsError: false,
        requests: (r.requests || []).map(q => Object.assign({}, q, describe(q), {
          // 群发的在有队接下之前没有归属
          teamText: q.team_name || t('所有配送队'),
          statusText: statusText(q),
          timeText: formatTime(q.created_at),
          deliveredText: formatTime(q.delivered_at)
        }))
      })
      if (done) done()
    }).catch(err => {
      console.error('读取配送记录失败：', err)
      this.setData({ requestsError: true })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
      if (done) done()
    })
  },

  pickTeam: function (e) {
    this.setData({ teamIndex: Number(e.currentTarget.dataset.index) })
  },

  onNote: function (e) {
    this.setData({ note: e.detail.value })
  },

  // 接了没来。记一次爽约，满 3 次这支队自动下架；店长可以重新发
  markNoShow: function (e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: f('「{0}」没来送？', name),
      content: t('会给这支队记一次爽约，满 3 次自动下架。确认对方确实没来、也没联系你再标。'),
      confirmText: t('没来送'),
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'deliveryRequest',
          data: { action: 'noShow', id: id }
        }).then(r => {
          const result = (r && r.result) || {}
          wx.showToast({ title: t(result.success ? '已记录，可以重新发请求' : (result.message || '操作失败')), icon: 'none' })
          this.loadRequests()
          this.loadTeams()
        }).catch(err => {
          console.error('标记没来送失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  reportTeam: function (e) {
    const teamId = e.currentTarget.dataset.team
    wx.showActionSheet({
      itemList: TEAM_REPORT_REASONS.map(r => t(r)),
      success: res => {
        // 举报的人最想知道后续，这一刻要授权成功率最高
        ask('reportResult')
        wx.cloud.callFunction({
          name: 'submitReport',
          data: { targetType: 'team', targetId: teamId, reason: TEAM_REPORT_REASONS[res.tapIndex] }
        }).then(r => {
          const result = (r && r.result) || {}
          wx.showToast({ title: t(result.success ? '举报已提交，我们会尽快核实' : (result.message || '提交失败')), icon: 'none' })
        }).catch(err => {
          console.error('举报配送队失败：', err)
          wx.showToast({ title: t('提交失败'), icon: 'none' })
        })
      },
      fail: () => { /* 取消 */ }
    })
  },

  // 点开送达照片看大图
  previewPhoto: function (e) {
    const { urls, current } = e.currentTarget.dataset
    if (!urls || !urls.length) return
    wx.previewImage({ urls: urls, current: current })
  },

  send: function () {
    const d = this.data
    if (d.sending) return

    if (!d.lines.length) {
      wx.showToast({ title: t('这一场还没有订单'), icon: 'none' })
      return
    }
    if (d.freeWarn) {
      wx.showToast({ title: t(d.freeWarn), icon: 'none' })
      return
    }
    if (d.teamIndex === null) {
      wx.showToast({ title: t('选一支配送队，或者发给所有队'), icon: 'none' })
      return
    }

    this.setData({ sending: true })
    wx.showLoading({ title: t('发送中'), mask: true })

    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: {
        action: 'create',
        teamId: d.teamIndex === ALL_TEAMS ? 'all' : d.teams[d.teamIndex]._id,
        note: d.note.trim()
      }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '发送失败'), icon: 'none' })
        return
      }
      this.setData({ note: '', teamIndex: null })
      this.loadRequests()
      wx.showToast({
        title: t(r.teamCount > 1 ? '已发给 ' + r.teamCount + ' 支队' : '已发出'),
        icon: 'success'
      })
    }).catch(err => {
      wx.hideLoading()
      console.error('发送配送请求失败：', err)
      wx.showToast({ title: t('发送失败'), icon: 'none' })
    }).then(() => {
      this.setData({ sending: false })
    })
  }
})
