// index.js
Page({
  data: {
    offers: [],
    menuItems: [],
    showOrderForm: false,       // 控制下单弹层显示
    selectedItem: null,         // 当前选中的菜品
    pickupName: '',             // 用户填的取餐名
    buildingIndex: null,        // 用户选的楼栋（下拉索引）
    buildings: ['Identity Dinkytown', 'Venue at Dinkytown', 'UNCOMMON Dinkytown', 'Radius Apartments', 'The Standard at Dinkytown', '44 North', 'Stadium Village Flats', 'University Village'],
  },
  goToMarket: function () {
    wx.navigateTo({ url: '/pages/market/market' })
  },
  onLoad: function () {
    const db = wx.cloud.database()
    db.collection('daily_offers').get().then(res => {
      console.log('读到的数据：', res.data)
      this.setData({
        offers: res.data
      })
    }).catch(err => {
      console.error('读取失败：', err)
    })
    db.collection('menu_items').get().then(res => {
      console.log('读到的菜品：', res.data)
      this.setData({
        menuItems: res.data
      })
    }).catch(err => {
      console.error('读菜品失败：', err)
    })
  },
  // 点菜品的"下单"，弹出表单
  openOrderForm: function (e) {
    this.setData({
      showOrderForm: true,
      selectedItem: e.currentTarget.dataset.item,
      pickupName: '',
      buildingIndex: null
    })
  },

  // 关闭表单
  closeOrderForm: function () {
    this.setData({ showOrderForm: false })
  },

  // 输入取餐名
  onPickupNameInput: function (e) {
    this.setData({ pickupName: e.detail.value })
  },

  // 选择楼栋
  onBuildingChange: function (e) {
    this.setData({ buildingIndex: e.detail.value })
  },

  // 确认下单
  submitOrder: function () {
    const item = this.data.selectedItem
    const pickupName = this.data.pickupName
    const buildingIndex = this.data.buildingIndex

    // 简单校验：必须填名字、选楼栋
    if (!pickupName) {
      wx.showToast({ title: '请填取餐名', icon: 'none' })
      return
    }
    if (buildingIndex === null) {
      wx.showToast({ title: '请选楼栋', icon: 'none' })
      return
    }

    const building = this.data.buildings[buildingIndex]
    const db = wx.cloud.database()

    db.collection('orders').add({
      data: {
        item_name: item.name,
        price: item.price_after_tax,
        offer_id: item.offer_id,
        pickup_name: pickupName,
        building: building,
        status: 'pending_payment',
        created_at: new Date()
      }
    }).then(res => {
      console.log('下单成功：', res._id)
      wx.showToast({ title: '下单成功！', icon: 'success' })
      this.setData({ showOrderForm: false })
    }).catch(err => {
      console.error('下单失败：', err)
      wx.showToast({ title: '下单失败', icon: 'none' })
    })
  },
  goToMyOrders: function () {
    wx.navigateTo({
      url: '/pages/myorders/myorders'
    })
  },
});
