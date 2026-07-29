Page({
  data: {
    itemSummary: [],    // 取餐清单：[{name, count}]
    buildingGroups: []  // 送餐清单：[{building, orders:[...]}]
  },

  onShow: function () {
    this.loadSummary()
  },

  loadSummary: function () {
    // 用云函数拿所有 confirmed 订单（需要管理员权限看所有人的）
    wx.cloud.callFunction({
      name: 'getConfirmedOrders'
    }).then(res => {
      if (!res.result.success) return
      const orders = res.result.orders
      console.log('已确认订单：', orders)

      // ===== 1. 取餐清单：按菜品名计数 =====
      const itemMap = {}
      orders.forEach(o => {
        // 如果这个菜名还没记过，初始化为0，然后+1
        itemMap[o.item_name] = (itemMap[o.item_name] || 0) + 1
      })
      // 把 {干锅土豆:2, 椰香咖喱鸡:1} 转成 [{name:'干锅土豆',count:2}, ...]
      const itemSummary = Object.keys(itemMap).map(name => ({
        name: name,
        count: itemMap[name]
      }))

      // ===== 2. 送餐清单：按楼栋分组 =====
      const buildingMap = {}
      orders.forEach(o => {
        const b = o.building || '未填楼栋'
        if (!buildingMap[b]) buildingMap[b] = []  // 这栋楼还没有，先建个空数组
        buildingMap[b].push({
          pickup_name: o.pickup_name || '未填名',
          item_name: o.item_name
        })
      })
      const buildingGroups = Object.keys(buildingMap).map(building => ({
        building: building,
        orders: buildingMap[building]
      }))

      this.setData({ itemSummary, buildingGroups })
    }).catch(err => {
      console.error('加载汇总失败：', err)
    })
  }
})