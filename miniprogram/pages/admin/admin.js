Page({
  data: {
    pendingOrders: []
  },

  onShow: function () {
    this.loadPendingOrders()
  },

  // 调用云函数，获取所有待确认订单
  loadPendingOrders: function () {
    wx.cloud.callFunction({
      name: 'getPendingOrders'
    }).then(res => {
      console.log('待确认订单：', res.result)
      if (res.result.success) {
        this.setData({
          pendingOrders: res.result.orders
        })
      }
    }).catch(err => {
      console.error('调用云函数失败：', err)
    })
  },

  // 管理员确认某个订单
  confirmOrder: function (e) {
    const orderId = e.currentTarget.dataset.id
    const db = wx.cloud.database()

    db.collection('orders').doc(orderId).update({
      data: {
        status: 'confirmed'
      }
    }).then(() => {
      wx.showToast({ title: '已确认', icon: 'success' })
      this.loadPendingOrders()  // 刷新列表
    }).catch(err => {
      console.error('确认失败：', err)
      wx.showToast({ title: '确认失败', icon: 'none' })
    })
  },
  goToSummary: function () {
    wx.navigateTo({
      url: '/pages/summary/summary'
    })
  },
})