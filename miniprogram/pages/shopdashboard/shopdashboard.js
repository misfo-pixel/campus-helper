// 商家工作台。订单状态全部由商家自己推进，平台不介入任何一步。
// 平台也不碰钱——订单里没有支付状态，小程序里也不出现任何收款方式。
// 订单只是买家的下单意向，商家自己通过微信联系买家后再决定接不接。

// 商家只有两态。closed 是系统态（待审 / 被拒 / 重审中），
// 商家选不到，但显示上也归到「打烊」——他不需要知道这个区别。
const SHOP_STATUS_TEXT = { open: '营业中', paused: '打烊', closed: '打烊' }
const SHOP_STATUS_LIST = [
  { value: 'open', label: '营业中（接单）' },
  { value: 'paused', label: '打烊（买家能看商品，但下不了单）' }
]

const ORDER_STATUS_TEXT = {
  pending: '待确认',
  accepted: '准备中',
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
    slotAlert: false,  // true = 没有可约的服务时间，买家下不了单
    slotLastDate: '',  // 上一场的日期；空 = 压根还没按日期设过
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
      const slot = this.checkSlot(shop)
      this.setData({
        shop: shop || null,
        shopStatusText: shop ? (SHOP_STATUS_TEXT[shop.status] || '') : '',
        slotAlert: slot.alert,
        slotLastDate: slot.lastDate,
        loading: false
      })
      // 被下架的店没有订单可看，就别白跑两个云函数了
      if (shop && !shop.takedown) {
        this.loadSummary()
        this.loadOrders()
      }
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
    })
  },

  // 场次过了就没人下得了单，可店还好端端挂在列表里，商家自己看不出来。
  //
  // 没有日期的场次也要报警：那是场次还没按日期填过的老数据，
  // 买家侧同样一个可选场次都展不出来，而且它比「过期」更隐蔽。
  //
  // 外包给配送队的店用的是队伍那份方案，不归他管，就别吓唬他了。
  checkSlot: function (shop) {
    if (!shop || shop.takedown) return { alert: false, lastDate: '' }
    if (shop.delivery_mode === 'outsourced') return { alert: false, lastDate: '' }

    const slot = (shop.batches || [])[0]
    if (!slot || !slot.date) return { alert: true, lastDate: '' }

    const d = new Date()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    if (slot.date < today) return { alert: true, lastDate: slot.date }

    // 今天的场次过了截单时刻也算没场次：买家侧同样展不出来。
    // 这条判断要和 shopManage 的 slotBlocker 对齐，否则会出现
    // 「工作台没报警，但一点营业中就被拒」的割裂。
    if (slot.date === today && slot.cutoff) {
      const bits = String(slot.cutoff).split(':')
      const cutoffMin = Number(bits[0]) * 60 + Number(bits[1])
      if (d.getHours() * 60 + d.getMinutes() >= cutoffMin) {
        return { alert: true, lastDate: slot.date }
      }
    }
    return { alert: false, lastDate: '' }
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
          } else if (next === 'open') {
            // 开门被场次拦下了。这时候只弹 toast 等于把人扔在原地，
            // 直接问他要不要去设置——拦截理由本身已经说清楚该改什么了。
            wx.showModal({
              title: '还不能开门',
              content: result.message || '切换失败',
              confirmText: '去设置',
              success: r => {
                if (r.confirm) wx.navigateTo({ url: '/pages/shopedit/shopedit' })
              }
            })
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
