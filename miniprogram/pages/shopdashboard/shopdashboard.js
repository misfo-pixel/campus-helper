// 我的小店（店长工作台）。
//
// 从上到下：开着的场次（进度、订单、修改、照常送）→ 两周的开团日历 → 订单。
// 2026-10-11 起没有「营业中 / 打烊」：某天能不能下单只看那天有没有场次。
//
// 日历上能看到别家的排期（灰点），方便错开：同一天两家都开，抢的是同一批人。
// 只显示别家买家本来就看得到的东西（店名、出发时间、取货点），不显示单数。
//
// 平台不碰钱——订单里没有支付状态，小程序里也不出现任何收款方式。
// 「确认订单」只表示店长认了这一单，之前要不要先收钱是他和买家的事。

const ORDER_STATUS_TEXT = {
  forming: '拼团中',
  confirming: '待确认',
  pending: '待确认',
  accepted: '已确认',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

const SESSION_STATE_TEXT = { formed: '已成团', failed: '未成团', cancelled: '已取消' }

const { ORDERING_ENABLED } = require('../../config.js')
const { askOrGuide } = require('../../utils/subscribe.js')
const { today, formatTime } = require('../../utils/date.js')
const { addDays, md, weekday, minutesBetween, cutoffText, progress, sessionTitle, atText } = require('../../utils/group.js')
const { t, f, getLang } = require('../../i18n/index.js')

const CALENDAR_DAYS = 14

function decorateSession(s, now) {
  const c = s.counts || { total: 0, forming: 0, confirming: 0, confirmed: 0 }
  const open = s.state === 'open'
  const p = progress({ count: c.total, min_orders: s.min_orders, forced: s.forced }, true)
  return Object.assign({}, s, {
    title: sessionTitle(s),
    open: open,
    p: p,
    countText: s.min_orders ? f('{0} / {1} 单', c.total, s.min_orders) : f('{0} 单', c.total),
    cutText: cutoffText({ cutoff_at: s.cutoff_at, minutes_left: minutesBetween(now, s.cutoff_at) }, now),
    stateText: t(SESSION_STATE_TEXT[s.state] || ''),
    confirmLine: s.state === 'formed'
      ? f('待确认 {0} · 已确认 {1} · {2} 截止', c.confirming, c.confirmed, atText(s.confirm_at, now))
      : '',
    gap: Math.max(0, (s.min_orders || 0) - c.total),
    canForce: open && !p.open && !p.formed,
    // 照常送了、又还没凑够：可以撤回去。凑够了撤不撤都成团，就不给按钮了
    canUnforce: open && !!p.forced,
    repeatText: s.repeat_weekly ? f('每{0}', weekday(s.date)) : ''
  })
}

// 手机本地时间，格式和云函数给的 now 一样：'YYYY-MM-DD HH:MM'
function localNow() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 两周的日历，按周一开头排成整周。今天本身开不了（截单在前一天），从明天起能点
function buildCalendar(now, mine, others) {
  const today = now.slice(0, 10)
  const last = addDays(today, CALENDAR_DAYS - 1)
  const wd = new Date(today + 'T12:00:00Z').getUTCDay()
  const start = addDays(today, -((wd + 6) % 7))

  const mineByDate = {}
  mine.filter(s => s.state === 'open' || s.state === 'formed').forEach(s => { mineByDate[s.date] = s._id })
  const othersByDate = {}
  others.forEach(o => { othersByDate[o.date] = (othersByDate[o.date] || 0) + 1 })

  const cells = []
  for (let date = start; date <= last || cells.length % 7; date = addDays(date, 1)) {
    const inRange = date > today && date <= last
    cells.push({
      date: date,
      day: Number(date.slice(8)),
      today: date === today,
      off: !inRange && !mineByDate[date],
      mine: mineByDate[date] || '',
      dots: othersByDate[date] ? new Array(Math.min(3, othersByDate[date])).fill(1) : []
    })
  }
  return cells
}

Page({
  data: {
    // 黄页模式下没有订单：场次、日历、订单整块不渲染
    ordering: ORDERING_ENABLED,
    loading: true,
    shop: null,
    sessions: [],
    week: getLang() === 'en' ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['一', '二', '三', '四', '五', '六', '日'],
    cells: [],
    summary: { todayCount: 0, pendingCount: 0, revenue: 0 },
    tab: 'forming',
    filter: null,      // 从场次卡片点「订单」进来：{ id, text }
    orders: []
  },

  onShow: function () {
    this.loadShop()
  },

  onPullDownRefresh: function () {
    this.loadShop(() => wx.stopPullDownRefresh())
  },

  loadShop: function (done) {
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}
      const shop = r.shop
      this.setData({ shop: shop || null, loading: false })
      // 被下架的店没有订单可看，就别白跑云函数了
      if (shop && !shop.takedown && ORDERING_ENABLED) {
        return Promise.all([this.loadSessions(), this.loadSummary(), this.loadOrders()])
      }
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
    }).then(() => {
      if (done) done()
    })
  },

  // 日历先按手机日期画出来，云函数回来再换成明尼苏达时间 + 场次。
  // 读失败时日历照样能点（开团页自己会再校验），并把原因弹出来——
  // 不然一片空白，看不出是没部署还是出错了
  loadSessions: function () {
    if (!this.data.cells.length) this.setData({ cells: buildCalendar(localNow(), [], []) })
    return wx.cloud.callFunction({ name: 'shopManage', data: { action: 'sessions' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '读取场次失败'), icon: 'none' })
        return
      }
      const mine = r.sessions || []
      this.setData({
        sessions: mine.map(s => decorateSession(s, r.now)),
        cells: buildCalendar(r.now, mine, r.others || [])
      })
    }).catch(err => {
      console.error('读取场次失败：', err)
      wx.showToast({ title: t('读取场次失败'), icon: 'none' })
    })
  },

  loadSummary: function () {
    return wx.cloud.callFunction({ name: 'shopOrders', data: { action: 'summary' } }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) this.setData({ summary: r.summary })
    }).catch(err => console.error('读取今日数据失败：', err))
  },

  loadOrders: function () {
    const filter = this.data.filter
    return wx.cloud.callFunction({
      name: 'shopOrders',
      data: { action: 'list', tab: this.data.tab, sessionId: filter ? filter.id : '' }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '读取失败'), icon: 'none' })
        return
      }
      const orders = (r.orders || []).map(o => Object.assign({}, o, {
        statusText: t(ORDER_STATUS_TEXT[o.status] || o.status),
        timeText: formatTime(o.created_at),
        dayText: o.batch_date ? md(o.batch_date) + ' ' + weekday(o.batch_date) : '',
        shortId: (o._id || '').slice(-6).toUpperCase()
      }))
      this.setData({ orders: orders })
    }).catch(err => {
      console.error('读取订单失败：', err)
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  switchTab: function (e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab: tab, orders: [] }, () => this.loadOrders())
  },

  // ---- 场次 ----

  // 日历上点一天：自己开过的去修改，空的去开团
  pickDay: function (e) {
    const cell = this.data.cells[Number(e.currentTarget.dataset.index)]
    if (!cell) return
    if (cell.mine) {
      wx.navigateTo({ url: '/pages/shopsession/shopsession?id=' + cell.mine })
      return
    }
    if (cell.today) {
      wx.showToast({ title: t('截单在前一天，最早开明天的团'), icon: 'none' })
      return
    }
    if (cell.off) return
    wx.navigateTo({ url: '/pages/shopsession/shopsession?date=' + cell.date })
  },

  // 转发卡片和海报：挑 AI 背景、生成海报、转发
  goToPoster: function (e) {
    wx.navigateTo({ url: '/pages/shopposter/shopposter?id=' + e.currentTarget.dataset.id })
  },

  editSession: function (e) {
    wx.navigateTo({ url: '/pages/shopsession/shopsession?id=' + e.currentTarget.dataset.id })
  },

  // 场次卡片上的「订单」：下面的订单列表只看这一场
  showSessionOrders: function (e) {
    const s = this.data.sessions.find(x => x._id === e.currentTarget.dataset.id)
    if (!s) return
    const tab = s.state === 'open' ? 'forming' : (s.state === 'formed' ? 'pending' : 'done')
    this.setData({
      filter: { id: s._id, text: md(s.date) + ' ' + weekday(s.date) },
      tab: tab,
      orders: []
    }, () => {
      this.loadOrders()
      wx.pageScrollTo({ selector: '#orders', duration: 200 })
    })
  },

  clearFilter: function () {
    this.setData({ filter: null, orders: [] }, () => this.loadOrders())
  },

  // 照常送：差几单没到门槛也送，截单时按成团算。
  // 点下去马上通知买家「一定开团」，所以先把后果说清楚再让店长点
  forceSession: function (e) {
    const s = this.data.sessions.find(x => x._id === e.currentTarget.dataset.id)
    if (!s) return
    wx.showModal({
      title: t('确定照常送？'),
      content: f('现在 {0} 单，还差 {1} 单到门槛。照常送之后：\n· 截单时不管够不够，这一场都按成团算，你要照常出发送货\n· 马上通知已下单的买家「一定开团」\n截单前可以撤销，但通知已经发出去了，买家会以为一定能送到。', s.counts ? s.counts.total : 0, s.gap),
      confirmText: t('照常送'),
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: t('处理中'), mask: true })
        wx.cloud.callFunction({ name: 'shopManage', data: { action: 'forceSession', sessionId: s._id } }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: t(result.message || '操作失败'), icon: 'none' })
            return
          }
          this.loadSessions()
          // 有人没开通知就发不到，照实告诉店长，别以为人人都知道了
          const buyers = result.buyers || 0
          const notified = result.notified || 0
          wx.showModal({
            title: t('已设为照常送'),
            content: result.already
              ? t('买家之前已经收到过拼团成功的通知，这次不再重复发。')
              : !buyers
                ? t('这一场还没人下单。之后下单的人会看到「店长照常送，一定开团」。')
                : result.pending
                  ? t('拼团成功通知还没开通，这次没能通知买家。他们在「我的订单」里能看到「店长照常送」。')
                  : notified >= buyers
                    ? f('已通知 {0} 位买家：这一场一定开团。', buyers)
                    : f('{0} 位买家里通知到了 {1} 位，其余的人下单时没开通知，收不到。他们在「我的订单」里能看到「店长照常送」。', buyers, notified),
            showCancel: false,
            confirmText: t('知道了')
          })
        }).catch(err => {
          wx.hideLoading()
          console.error('照常送失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  // 撤销照常送：回到满门槛才成团。买家的通知票已经用掉，撤销没法再通知
  unforceSession: function (e) {
    const s = this.data.sessions.find(x => x._id === e.currentTarget.dataset.id)
    if (!s) return
    wx.showModal({
      title: t('撤销照常送？'),
      content: f('撤销后要满 {0} 单才成团，截单时还差的话，这一场和所有订单会自动取消。\n买家已经收到「一定开团」的通知。撤销后，截单前 2 小时还没凑够的话，他们会收到「还差 N 位」的提醒（之前收到过的不会再收到）。', s.min_orders),
      confirmText: t('撤销'),
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: t('处理中'), mask: true })
        wx.cloud.callFunction({ name: 'shopManage', data: { action: 'unforceSession', sessionId: s._id } }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: t(result.message || '操作失败'), icon: 'none' })
            return
          }
          wx.showToast({ title: t('已撤销照常送'), icon: 'none' })
          this.loadSessions()
        }).catch(err => {
          wx.hideLoading()
          console.error('撤销照常送失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  // ---- 订单 ----

  confirmOrder: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'accepted')
  },

  startDelivery: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'delivering')
  },

  completeOrder: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'completed')
  },

  cancelOrder: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: t('取消订单'),
      editable: true,
      placeholderText: t('告诉买家原因（选填）'),
      success: res => {
        if (res.confirm) this.updateStatus(id, 'cancelled', res.content || '')
      }
    })
  },

  updateStatus: function (orderId, status, reason) {
    wx.showLoading({ title: t('处理中'), mask: true })
    wx.cloud.callFunction({
      name: 'shopOrders',
      data: { action: 'updateStatus', orderId: orderId, status: status, reason: reason || '' }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: t('已更新'), icon: 'success' })
        this.loadOrders()
        this.loadSummary()
        this.loadSessions()
      } else {
        wx.showToast({ title: t(r.message || '操作失败'), icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('更新订单状态失败：', err)
      wx.showToast({ title: t('操作失败'), icon: 'none' })
    })
  },

  // 找不到人、到了没人应的时候用
  callBuyer: function (e) {
    const phone = e.currentTarget.dataset.phone
    if (!phone) return
    wx.makePhoneCall({ phoneNumber: phone.replace(/[^\d+]/g, ''), fail: () => {} })
  },

  copyContact: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: t('已复制'), icon: 'success' })
    })
  },

  goToMenu: function () {
    wx.navigateTo({ url: '/pages/shopmenu/shopmenu' })
  },

  // 订阅消息一次授权只能收一条，所以这是个要反复点的按钮，不是开关。
  // 微信没给「长期订阅」的口子（那个只对政务医疗等类目开放）。
  //
  // 成功给个 toast 就够，失败什么都不说——再点一次就会再弹。
  // 只有被永久拒绝时 askOrGuide 会自己引导去设置，那是唯一点了也没反应的情况。
  enableOrderAlert: function () {
    askOrGuide('newOrder').then(ok => {
      if (ok) wx.showToast({ title: t('已开启'), icon: 'success' })
    })
  },

  previewNoteImages: function (e) {
    const urls = e.currentTarget.dataset.urls || []
    wx.previewImage({ urls: urls, current: e.currentTarget.dataset.url })
  },

  goToSettings: function () {
    wx.navigateTo({ url: '/pages/shopedit/shopedit' })
  },
  goToApply: function () {
    wx.navigateTo({ url: '/pages/shopcreate/shopcreate' })
  }
})
