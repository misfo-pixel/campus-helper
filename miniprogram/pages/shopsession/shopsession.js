// 开团 / 改场次。从「我的小店」的日历点进来：空的日子带 date，自己开过的带 id。
//
// 截单固定在出发前一天，店长只选几点；确认截止不让店长填，自动算：
// 截单后 12 小时，最晚出发前 1 小时（和云函数 shopManage 的 buildTimes 同一个算法，
// 这里算只是为了显示，存的时候以云函数为准）。
//
// 有人下单之后日期、时间、取货点都定死了，只能调低门槛、开关每周重复——
// 不然已经下单的人会发现自己参的团变了样。截单之后只剩每周重复和取消。

const { ask } = require('../../utils/subscribe.js')
const { addDays, md, weekday } = require('../../utils/group.js')

const MIN_OPTIONS = [0, 3, 5, 8, 10, 15, 20, 30]
const DEFAULT_MIN = 10
const DEFAULT_DEPART = '17:00'
const DEFAULT_CUTOFF = '22:00'
const CALENDAR_DAYS = 14

function shiftAt(at, minutes) {
  const d = new Date(at.replace(' ', 'T') + ':00Z')
  d.setUTCMinutes(d.getUTCMinutes() + minutes)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function atLabel(at) {
  return md(at) + ' ' + weekday(at.slice(0, 10)) + ' ' + at.slice(11, 16)
}

function minLabel(n) {
  return n ? n + ' 单' : '不设门槛'
}

Page({
  data: {
    loading: true,
    saving: false,
    editing: false,     // 改已有的场次
    locked: false,      // 已经有人下单：只能调低门槛、开关每周重复
    closed: false,      // 已经截单：只剩每周重复和取消
    stateText: '',
    count: 0,

    date: '',
    dateLabel: '',
    dateStart: '',
    dateEnd: '',
    depart_time: DEFAULT_DEPART,
    cutoff: DEFAULT_CUTOFF,
    cutoffLabel: '',
    confirmLabel: '',
    tooEarly: false,

    minOptions: MIN_OPTIONS,
    minLabels: MIN_OPTIONS.map(minLabel),
    minIndex: MIN_OPTIONS.indexOf(DEFAULT_MIN),
    repeat: false,

    points: [],         // [{ name, arrive, fee, on }]
    exactAddress: false,
    others: []
  },

  onLoad: function (options) {
    this.sessionId = options.id || ''
    wx.cloud.callFunction({
      name: 'shopManage',
      data: { action: 'sessionForm', sessionId: this.sessionId, date: options.date || '' }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      const today = r.now.slice(0, 10)
      const s = r.session
      const picked = s ? (s.points || []).map(p => p.name) : null
      const min = s ? (s.min_orders || 0) : DEFAULT_MIN

      wx.setNavigationBarTitle({ title: s ? '这一场' : '开团' })
      this.setData({
        loading: false,
        editing: !!s,
        locked: !!s && r.count > 0,
        closed: !!s && (s.state !== 'open' || s.cutoff_at <= r.now),
        stateText: s ? ({ formed: '已成团', failed: '未成团', cancelled: '已取消' }[s.state] || '') : '',
        count: r.count || 0,
        date: s ? s.date : options.date,
        dateStart: addDays(today, 1),
        dateEnd: addDays(today, CALENDAR_DAYS - 1),
        depart_time: s ? s.depart_time : DEFAULT_DEPART,
        cutoff: s ? s.cutoff : DEFAULT_CUTOFF,
        minIndex: Math.max(0, MIN_OPTIONS.indexOf(min)),
        // 门槛不在选项里（老数据或以后改了选项），补进去免得显示错
        minOptions: MIN_OPTIONS.indexOf(min) === -1 ? MIN_OPTIONS.concat(min).sort((a, b) => a - b) : MIN_OPTIONS,
        repeat: s ? s.repeat_weekly === true : false,
        exactAddress: r.exact_address === true,
        points: (r.points || []).map(p => ({
          name: p.name,
          eta: Number(p.eta_minutes) || 0,
          fee: Number(p.fee) || 0,
          on: picked ? picked.indexOf(p.name) !== -1 : true
        })),
        others: r.others || []
      }, () => {
        const opts = this.data.minOptions
        this.setData({ minLabels: opts.map(minLabel), minIndex: Math.max(0, opts.indexOf(min)) })
        this.refreshTimes()
      })
    }).catch(err => {
      console.error('读取开团信息失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 截单、确认截止、各取货点约几点到，都跟着日期和出发时间走
  refreshTimes: function () {
    const d = this.data
    if (!d.date) return
    const departAt = d.date + ' ' + d.depart_time
    const cutoffAt = shiftAt(d.date + ' ' + d.cutoff, -24 * 60)
    const a = shiftAt(cutoffAt, 12 * 60)
    const b = shiftAt(departAt, -60)
    const confirmAt = a < b ? a : b
    const patch = {
      dateLabel: md(d.date) + ' ' + weekday(d.date),
      cutoffLabel: atLabel(cutoffAt),
      confirmLabel: atLabel(confirmAt),
      tooEarly: confirmAt < shiftAt(cutoffAt, 60)
    }
    d.points.forEach((p, i) => {
      patch['points[' + i + '].arrive'] = shiftAt(departAt, p.eta).slice(11, 16)
    })
    this.setData(patch)
  },

  onDate: function (e) {
    this.setData({ date: e.detail.value }, () => this.refreshTimes())
  },

  onDepart: function (e) {
    this.setData({ depart_time: e.detail.value }, () => this.refreshTimes())
  },

  onCutoff: function (e) {
    this.setData({ cutoff: e.detail.value }, () => this.refreshTimes())
  },

  onMin: function (e) {
    const i = Number(e.detail.value)
    if (this.data.locked && this.data.minOptions[i] > this.data.minOptions[this.data.minIndex]) {
      wx.showToast({ title: '已经有人下单，门槛只能调低', icon: 'none' })
      return
    }
    this.setData({ minIndex: i })
  },

  onRepeat: function (e) {
    this.setData({ repeat: e.detail.value })
  },

  togglePoint: function (e) {
    if (this.data.locked) return
    const i = Number(e.currentTarget.dataset.index)
    this.setData({ ['points[' + i + '].on']: !this.data.points[i].on })
  },

  goToSettings: function () {
    wx.navigateTo({ url: '/pages/shopedit/shopedit' })
  },

  submit: function () {
    const d = this.data
    if (d.saving) return
    if (!d.closed && !d.locked) {
      if (d.tooEarly) {
        wx.showToast({ title: '出发太早，留不出确认时间', icon: 'none' })
        return
      }
      if (!d.exactAddress && !d.points.some(p => p.on)) {
        wx.showToast({ title: '至少选一个取货点', icon: 'none' })
        return
      }
    }

    // 刚开团 = 开始等单，这一刻要新单提醒的授权最自然。
    // 必须是这次点击里的第一个调用，前面不能有 await，否则真机弹不出来
    const asked = d.editing ? Promise.resolve() : ask('newOrder')

    asked.then(() => {
      this.setData({ saving: true })
      return wx.cloud.callFunction({
        name: 'shopManage',
        data: {
          action: d.editing ? 'updateSession' : 'openSession',
          sessionId: this.sessionId,
          date: d.date,
          depart_time: d.depart_time,
          cutoff: d.cutoff,
          min_orders: d.minOptions[d.minIndex],
          repeat_weekly: d.repeat,
          points: d.points.filter(p => p.on).map(p => p.name)
        }
      })
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }
      // 开团提醒：通知订阅了这家店的买家。不等结果，同一场服务端只发一次
      if (!d.editing && r.sessionId) {
        wx.cloud.callFunction({ name: 'shopSubscribe', data: { action: 'announceSession', sessionId: r.sessionId } })
          .catch(err => console.warn('开团提醒触发失败：', err))
      }
      wx.showToast({ title: d.editing ? '已保存' : '已开团', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    }).catch(err => {
      console.error('保存场次失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }).then(() => {
      this.setData({ saving: false })
    })
  },

  cancelSession: function () {
    wx.showModal({
      title: '取消这一场',
      content: this.data.count ? '这一场的 ' + this.data.count + ' 单会一起取消。' : '确定取消吗？',
      confirmText: '取消这一场',
      cancelText: '再想想',
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'shopManage',
          data: { action: 'cancelSession', sessionId: this.sessionId }
        }).then(r => {
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: result.message || '取消失败', icon: 'none' })
            return
          }
          wx.showToast({ title: '已取消', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 800)
        }).catch(err => {
          console.error('取消场次失败：', err)
          wx.showToast({ title: '取消失败', icon: 'none' })
        })
      }
    })
  }
})
