// 店铺详情 + 点菜。
//
// 购物车只在这一页存活，点「去结算」时写进 storage 交给结算页。
// 前端算的金额只用来显示，真正的总价由 buyerOrders 云函数按数据库当前价重算。

const CART_KEY = 'foodCart'

Page({
  data: {
    loading: true,
    shop: null,
    items: [],
    groups: [],
    cart: {},          // { itemId: count }
    cartCount: 0,
    cartSubtotal: 0,
    canOrder: false,   // 店在营业 + 到起送价
    reachMin: false
  },

  onLoad: function (options) {
    if (!options.id) {
      wx.showToast({ title: '缺少店铺信息', icon: 'none' })
      return
    }
    this.shopId = options.id
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'shopBrowse',
      data: { action: 'detail', shopId: this.shopId }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showModal({
          title: '打不开这家店',
          content: r.message || '店铺可能已经打烊了',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }
      this.setData({ shop: r.shop, items: r.items || [], loading: false }, () => this.rebuild())
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 购物车一变就整体重算一次。菜单最多百来道菜，重建比维护 setData 路径省心得多。
  rebuild: function () {
    const cart = this.data.cart
    const map = {}
    const order = []

    this.data.items.forEach(item => {
      const cat = item.category || '其他'
      if (!map[cat]) {
        map[cat] = []
        order.push(cat)
      }
      map[cat].push(Object.assign({}, item, { count: cart[item._id] || 0 }))
    })
    order.sort((a, b) => (a === '其他' ? 1 : b === '其他' ? -1 : 0))

    let count = 0
    let subtotal = 0
    this.data.items.forEach(item => {
      const n = cart[item._id] || 0
      count += n
      subtotal += n * item.price
    })
    subtotal = Math.round(subtotal * 100) / 100

    const shop = this.data.shop || {}
    const reachMin = subtotal >= (Number(shop.min_order) || 0)

    this.setData({
      groups: order.map(cat => ({ category: cat, items: map[cat] })),
      cartCount: count,
      cartSubtotal: subtotal,
      reachMin: reachMin,
      canOrder: shop.status === 'open' && count > 0 && reachMin
    })
  },

  addItem: function (e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find(i => i._id === id)
    if (!item || !item.available) return

    if (this.data.shop.status !== 'open') {
      wx.showToast({ title: '店铺暂停接单', icon: 'none' })
      return
    }

    const cart = Object.assign({}, this.data.cart)
    cart[id] = (cart[id] || 0) + 1
    this.setData({ cart: cart }, () => this.rebuild())
  },

  removeItem: function (e) {
    const id = e.currentTarget.dataset.id
    const cart = Object.assign({}, this.data.cart)
    if (!cart[id]) return

    cart[id] -= 1
    if (cart[id] <= 0) delete cart[id]
    this.setData({ cart: cart }, () => this.rebuild())
  },

  checkout: function () {
    if (this.data.shop.status !== 'open') {
      wx.showToast({ title: '店铺暂停接单', icon: 'none' })
      return
    }
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '还没选菜', icon: 'none' })
      return
    }
    if (!this.data.reachMin) {
      wx.showToast({ title: '还没到起送价 $' + this.data.shop.min_order, icon: 'none' })
      return
    }

    const cart = this.data.cart
    const chosen = this.data.items
      .filter(i => cart[i._id] > 0)
      .map(i => ({ item_id: i._id, name: i.name, price: i.price, count: cart[i._id] }))

    wx.setStorageSync(CART_KEY, {
      shopId: this.data.shop._id,
      shopName: this.data.shop.name,
      items: chosen,
      subtotal: this.data.cartSubtotal,
      payment_note: this.data.shop.payment_note,
      shop_wechat: this.data.shop.contact_wechat
    })

    wx.navigateTo({ url: '/pages/foodcheckout/foodcheckout' })
  }
})
