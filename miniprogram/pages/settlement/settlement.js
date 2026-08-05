// 对账页。商家和配送队共用，靠 URL 上的 as 参数决定站在哪一边看。
//
// 上半是「待结算」——还没打包成账单的单，双方看到的数是同一个。
// 下半是历史账单，每笔记着单数、金额、双方确认到哪一步了。
//
// 平台不碰钱：这一页只负责让两边对上数，转账在微信/Venmo 里自己完成。

const STATUS_TEXT = {
  pending: '待商家转账',
  paid: '商家已转账，待队伍确认',
  settled: '已结清'
}

function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate())
}

Page({
  data: {
    as: 'team',
    loading: true,
    actor: null,
    groups: [],
    settlements: []
  },

  onLoad: function (options) {
    this.setData({ as: options.as === 'shop' ? 'shop' : 'team' })
    wx.setNavigationBarTitle({ title: '配送费对账' })
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    const as = this.data.as
    Promise.all([
      wx.cloud.callFunction({ name: 'settlement', data: { action: 'summary', as: as } }),
      wx.cloud.callFunction({ name: 'settlement', data: { action: 'list', as: as } })
    ]).then(([sumRes, listRes]) => {
      const s = (sumRes && sumRes.result) || {}
      const l = (listRes && listRes.result) || {}

      if (!s.success) {
        this.setData({ loading: false })
        wx.showToast({ title: s.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }

      this.setData({
        loading: false,
        actor: s.actor,
        groups: s.groups || [],
        settlements: (l.settlements || []).map(b => Object.assign({}, b, {
          statusText: STATUS_TEXT[b.status] || b.status,
          createdText: formatDate(b.created_at)
        }))
      })
      if (done) done()
    }).catch(err => {
      console.error('读取对账失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  createBill: function (e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    const amount = e.currentTarget.dataset.amount
    const count = e.currentTarget.dataset.count

    wx.showModal({
      title: '发起对账',
      content: '把和「' + name + '」之间 ' + count + ' 单、合计 $' + amount +
               ' 的配送费打包成一张账单。打包后这些单不会再重复计入下一次对账。',
      confirmText: '生成账单',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '生成中', mask: true })
        wx.cloud.callFunction({
          name: 'settlement',
          data: { action: 'create', as: this.data.as, counterpartId: id }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '账单已生成', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '生成失败', icon: 'none' })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('生成账单失败：', err)
          wx.showToast({ title: '生成失败', icon: 'none' })
        })
      }
    })
  },

  markPaid: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '标记已转账',
      content: '确认你已经把这笔配送费转给配送队了？队长确认收到后这笔就结清。',
      success: res => {
        if (res.confirm) this.act('markPaid', id)
      }
    })
  },

  confirmReceived: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认收款',
      content: '确认已经收到这笔钱？确认后账单结清，相关订单不会再出现在待结算里。',
      success: res => {
        if (res.confirm) this.act('confirm', id)
      }
    })
  },

  cancelBill: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '撤回账单',
      content: '撤回后这些订单会退回待结算，可以重新打包。',
      success: res => {
        if (res.confirm) this.act('cancel', id)
      }
    })
  },

  act: function (action, settlementId) {
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'settlement',
      data: { action: action, as: this.data.as, settlementId: settlementId }
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
      console.error(action + ' 失败：', err)
      wx.showToast({ title: '处理失败', icon: 'none' })
    })
  },

  copyText: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  }
})
