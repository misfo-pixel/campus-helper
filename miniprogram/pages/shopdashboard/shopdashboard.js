// 商家工作台。订单状态全部由商家自己推进，平台不介入任何一步。
// 平台也不碰钱——订单里没有支付状态，商家是在小程序外收到钱之后才点「接单」的。

const SHOP_STATUS_TEXT = { open: '营业中', paused: '暂停接单', closed: '打烊' }
const SHOP_STATUS_LIST = [
  { value: 'open', label: '营业中（正常接单）' },
  { value: 'paused', label: '暂停接单（仍显示在列表，但不能下单）' },
  { value: 'closed', label: '打烊（不在列表中显示）' }
]

const ORDER_STATUS_TEXT = {
  pending: '待确认',
  accepted: '备餐中',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    loading: true,
    shop: null,
    shopStatusText: '',
    summary: { todayCount: 0, pendingCount: 0, revenue: 0 },
    tab: 'pending',
    orders: []
  },

  onShow: function () {
    this.loadShop()
  },

  loadShop: function () {
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}
      const shop = r.shop
      this.setData({
        shop: shop || null,
        shopStatusText: shop ? (SHOP_STATUS_TEXT[shop.status] || '') : '',
        loading: false
      })
      // 审核没过的时候没有订单可看，就别白跑两个云函数了
      if (shop && shop.audit_status === 'approved') {
        this.loadSummary()
        this.loadOrders()
      }
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
    })
  },

  loadSummary: function () {
    wx.cloud.callFunction({ name: 'shopOrders', data: { action: 'summary' } }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) this.setData({ summary: r.summary })
    }).catch(err => console.error('读取今日数据失败：', err))
  },

  loadOrders: function () {
    wx.cloud.callFunction({
      name: 'shopOrders',
      data: { action: 'list', tab: this.data.tab }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      const orders = (r.orders || []).map(o => Object.assign({}, o, {
        statusText: ORDER_STATUS_TEXT[o.status] || o.status,
        timeText: formatTime(o.created_at),
        shortId: (o._id || '').slice(-6).toUpperCase()
      }))
      this.setData({ orders: orders })
    }).catch(err => {
      console.error('读取订单失败：', err)
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  switchTab: function (e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab: tab, orders: [] }, () => this.loadOrders())
  },

  // 营业状态是商家最高频的操作，放在最顶上一点就能切
  changeShopStatus: function () {
    wx.showActionSheet({
      itemList: SHOP_STATUS_LIST.map(s => s.label),
      success: res => {
        const next = SHOP_STATUS_LIST[res.tapIndex].value
        if (next === this.data.shop.status) return

        wx.cloud.callFunction({
          name: 'shopManage',
          data: { action: 'setStatus', status: next }
        }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已切换为' + SHOP_STATUS_TEXT[next], icon: 'none' })
            this.loadShop()
          } else {
            wx.showToast({ title: result.message || '切换失败', icon: 'none' })
          }
        }).catch(err => {
          console.error('切换营业状态失败：', err)
          wx.showToast({ title: '切换失败', icon: 'none' })
        })
      },
      fail: () => { /* 用户取消 */ }
    })
  },

  acceptOrder: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'accepted')
  },

  startDelivery: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'delivering')
  },

  completeOrder: function (e) {
    this.updateStatus(e.currentTarget.dataset.id, 'completed')
  },

  rejectOrder: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '拒单',
      editable: true,
      placeholderText: '告诉买家原因（选填）',
      success: res => {
        if (res.confirm) this.updateStatus(id, 'cancelled', res.content || '')
      }
    })
  },

  updateStatus: function (orderId, status, reason) {
    wx.showLoading({ title: '处理中', mask: true })
    wx.cloud.callFunction({
      name: 'shopOrders',
      data: { action: 'updateStatus', orderId: orderId, status: status, reason: reason || '' }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已更新', icon: 'success' })
        this.loadOrders()
        this.loadSummary()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('更新订单状态失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    })
  },

  copyWechat: function (e) {
    const wechat = e.currentTarget.dataset.wechat
    if (!wechat) return
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  },

  goToMenu: function () {
    wx.navigateTo({ url: '/pages/shopmenu/shopmenu' })
  },
  goToSettings: function () {
    wx.navigateTo({ url: '/pages/shopedit/shopedit' })
  },
  goToSettlement: function () {
    wx.navigateTo({ url: '/pages/settlement/settlement?as=shop' })
  },
  goToApply: function () {
    wx.navigateTo({ url: '/pages/shopedit/shopedit' })
  }
})
