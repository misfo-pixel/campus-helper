// 一起拼团（列表）。
//
// 按送达日分组往下排，不做「周一…周日」标签：场次少的时候标签大多是空的，
// 看着像没生意；按天分组只列有场次的日子，一屏看完一周。
// 同一天里最接近成团的排前面，不设门槛的排最后。
// 截单后的场次不在这里，只在下过单的人的「我的订单」里。
//
// 顶上「我的拼团」只在我有拼团中 / 待确认的单时出现：待确认的要去联系店长，
// 拼团中的可以直接在这里转发喊人。

const { ORDERING_ENABLED } = require('../../config.js')
const { weekday, relDay, cutoffText, progress, shareTitle, pointsText, atText, cardData } = require('../../utils/group.js')

function decorate(s, now) {
  const p = progress(s, false)
  return Object.assign({}, s, {
    p: p,
    cutText: cutoffText(s, now),
    cutHot: s.minutes_left != null && s.minutes_left < 180,
    pointsText: pointsText(s.points),
    repeatText: s.repeat_weekly ? '每' + weekday(s.date) : ''
  })
}

// 同一天里：差得最少的在前（已成团算差 0），不设门槛的在最后
function rank(s) {
  return s.p.open ? 1000 : s.p.gap
}

Page({
  data: {
    ordering: ORDERING_ENABLED,
    loading: true,
    days: [],          // [{ date, dayNum, week, rel, sessions }]
    shops: [],         // 眼下没场次的店
    showShops: false,
    mine: []
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'shopBrowse', data: { action: 'list' } }).then(res => {
      const r = (res && res.result) || {}
      if (done) done()
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      const now = r.now
      const byDate = {}
      const order = []
      ;(r.sessions || []).forEach(raw => {
        const s = decorate(raw, now)
        if (!byDate[s.date]) {
          byDate[s.date] = []
          order.push(s.date)
        }
        byDate[s.date].push(s)
      })
      order.sort()
      const days = order.map(date => ({
        date: date,
        dayNum: Number(date.slice(8)),
        monthText: Number(date.slice(5, 7)) + '月',
        week: weekday(date),
        rel: relDay(date, now),
        sessions: byDate[date].sort((a, b) => rank(a) - rank(b))
      }))

      const mine = (r.mine || []).map(o => Object.assign({}, o, {
        p: progress(o.session, true),
        confirmText: atText(o.confirm_at, now)
      }))

      this.setData({
        loading: false,
        days: days,
        shops: r.shops || [],
        // 一场都没有的时候，其他小店直接展开，别让页面空着
        showShops: this.data.showShops || days.length === 0,
        mine: mine
      })
    }).catch(err => {
      if (done) done()
      console.error('读取拼团列表失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  toggleShops: function () {
    this.setData({ showShops: !this.data.showShops })
  },

  goToSession: function (e) {
    const { shop, session } = e.currentTarget.dataset
    wx.navigateTo({ url: '/pages/shopdetail/shopdetail?id=' + shop + (session ? '&s=' + session : '') })
  },

  goToMyOrders: function () {
    wx.navigateTo({ url: '/pages/myshoporders/myshoporders' })
  },

  // 「喊人上车」是转发按钮，点的哪一单从 dataset 里拿
  onShareAppMessage: function (res) {
    const i = res && res.target && res.target.dataset ? res.target.dataset.index : undefined
    const o = i !== undefined ? this.data.mine[i] : null
    if (o) {
      const share = {
        title: shareTitle(o.shop_name, o.session, true),
        path: '/pages/shopdetail/shopdetail?id=' + o.shop_id + '&s=' + o.session._id + '&from=share'
      }
      // 卡片主图现画：微信最多等 3 秒，画不完就用上面这份（默认截图）
      // 微信最多等 3 秒：从 logo 取色（取过的有缓存）再画，来不及就用上面这份
      const gs = this.selectComponent('#gs')
      const shop = { name: o.shop_name, slogan: o.slogan, logo: o.logo, poster_style: o.poster_style }
      share.promise = gs.themeFor(shop)
        .then(theme => gs.card(cardData(shop, o.session, [], theme)))
        .then(p => Object.assign({}, share, { imageUrl: p }))
        .catch(() => share)
      return share
    }
    return { title: '一起拼团 · 满单成团，送到学校', path: '/pages/shoplist/shoplist' }
  }
})
