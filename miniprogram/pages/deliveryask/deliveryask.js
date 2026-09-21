// 配送状态。店长在这儿发配送请求，也在这儿看进度和送达照片。
//
// 这是配送队体系精简后店长侧的全部。原来那套（外包给队伍 → 买家按队伍的
// 方案下单 → 队伍按批次领活 → 配送费三态对账）代码还在，但不走了：
// 现阶段没有真实的配送队，那套工作流服务的是一个不存在的角色。
//
// 平台在这里只做三件事：把请求记下来、给队长发提醒、存一份送达照片。
// 送不送、给多少钱、怎么结，全是他们俩的事。

const STATUS_TEXT = {
  open: '等队长联系',
  accepted: '配送中',
  delivered: '已送达'
}

const { formatTime, slotText } = require('../../utils/date.js')

// 队伍的可配送时段最多显示几条：卡片是用来挑队伍的，不是排班表。
// 剩下的等选中之后在微信里问，反正约时间本来就要聊。
const SHOWN_SLOTS = 4

Page({
  data: {
    loading: true,
    teamsError: false,     // 读队伍列表失败：不能显示成「平台上还没有配送队」
    requestsError: false,  // 读配送记录失败：不能显示成「你还没发过配送请求」
    teams: [],
    teamIndex: null,
    note: '',
    sending: false,
    requests: []
  },

  onShow: function () {
    this.loadTeams()
    this.loadRequests()
  },

  onPullDownRefresh: function () {
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
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      // 一支队都不滤掉。这一页发的是自由文本请求（「周六晚上三单」），
      // 没有结构化的送达时间可比，服务端也不知道店长想约哪一趟——
      // 小店设置里那套按送达时刻置灰的判断在这儿没有依据。
      //
      // 所以改成把队长填的可配送时段摊平成几行字摆在队伍名下面，让店长自己看：
      // 挑队伍时最想知道的就是「这支队什么时候能出车」，
      // 不然选完还得加微信问一轮才发现时间对不上。
      // 一条时段都没填的队，云函数已经排到最后了。
      const teams = (r.teams || []).map(t => {
        const slots = (t.availability || []).map(slotText)
        return Object.assign({}, t, {
          slotTexts: slots.slice(0, SHOWN_SLOTS),
          slotMore: Math.max(0, slots.length - SHOWN_SLOTS)
        })
      })
      this.setData({ teams: teams, loading: false, teamsError: false })
    }).catch(err => {
      console.error('读取配送队失败：', err)
      this.setData({ loading: false, teamsError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
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
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }

      this.setData({
        requestsError: false,
        requests: (r.requests || []).map(q => Object.assign({}, q, {
          statusText: STATUS_TEXT[q.status] || q.status,
          timeText: formatTime(q.created_at),
          deliveredText: formatTime(q.delivered_at)
        }))
      })
      if (done) done()
    }).catch(err => {
      console.error('读取配送记录失败：', err)
      this.setData({ requestsError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  pickTeam: function (e) {
    this.setData({ teamIndex: Number(e.currentTarget.dataset.index) })
  },

  onNote: function (e) {
    this.setData({ note: e.detail.value })
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

    if (d.teamIndex === null) {
      wx.showToast({ title: '先选一支配送队', icon: 'none' })
      return
    }
    if (!d.note.trim()) {
      wx.showToast({ title: '说清楚几单、什么时候、送到哪', icon: 'none' })
      return
    }

    this.setData({ sending: true })
    wx.showLoading({ title: '发送中', mask: true })

    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: {
        action: 'create',
        teamId: d.teams[d.teamIndex]._id,
        note: d.note.trim()
      }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '发送失败', icon: 'none' })
        return
      }
      this.setData({ note: '', teamIndex: null })
      this.loadRequests()
      wx.showToast({ title: '已发出', icon: 'success' })
    }).catch(err => {
      wx.hideLoading()
      console.error('发送配送请求失败：', err)
      wx.showToast({ title: '发送失败', icon: 'none' })
    }).then(() => {
      this.setData({ sending: false })
    })
  }
})
