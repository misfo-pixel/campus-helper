// 店铺详情 + 点单。
//
// 购物车只在这一页存活，点「去结算」时写进 storage 交给结算页。
// 前端算的金额只用来显示，真正的总价由 buyerOrders 云函数按数据库当前价重算。

const { withCover, clip } = require('../../utils/share.js')
const { toLocalPath } = require('../../utils/poster.js')

const CART_KEY = 'foodCart'
const NAME_MAX = 12   // 转发标题里留给店名的字数，后面还要写得下截单时间

// 转发标题里的「什么时候截单」。
//
// 卡片一转出去标题就定死了，在群里能躺到第二天还有人点，所以不写「今天」
// 「还有 40 分钟截单」这种会过期的说法——那套是结算页当场看的，这里不能用。
// 场次带着具体日期，写出来哪天翻到都成立。
function cutoffPhrase(batches) {
  const b = (batches || [])[0]
  if (!b || !b.cutoff) return ''

  const day = b.date ? b.date.slice(5) + ' ' : ''
  // 群友问完「几点截单」，下一个问题就是「几点能拿」，所以两个时间都写上
  return b.deliver_time
    ? day + b.cutoff + ' 截单，' + b.deliver_time + ' 送达'
    : day + b.cutoff + ' 截单'
}

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
    reachMin: false,
    isRootPage: false  // 从转发卡片冷启动进来时页面栈只有这一页，没有上一页可返回
  },

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

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
      // 配送方案这一页用不上，但转发标题要写截单时间，顺手留下（省一次往返）
      this.batches = ((r.plan || {}).availableBatches) || []
      this.setData({ shop: r.shop, items: r.items || [], loading: false }, () => {
        this.rebuild()
        this.prefetchCover()
      })
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 购物车一变就整体重算一次。商品最多百来件，重建比维护 setData 路径省心得多。
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

    // 小店没开分类展示时，所有商品归成一条无标题的列表。
    // 一件商品都没有时要给空数组——否则 groups.length 恒为 1，空状态永远不显示。
    const grouped = order.length === 0
      ? []
      : (shop.use_category
          ? order.map(cat => ({ category: cat, items: map[cat] }))
          : [{ category: '', items: order.reduce((all, cat) => all.concat(map[cat]), []) }])

    this.setData({
      groups: grouped,
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
      wx.showToast({ title: '店铺已打烊', icon: 'none' })
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
      wx.showToast({ title: '店铺已打烊', icon: 'none' })
      return
    }
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '还没选商品', icon: 'none' })
      return
    }
    if (!this.data.reachMin) {
      wx.showToast({ title: '还没到起送价 $' + this.data.shop.min_order, icon: 'none' })
      return
    }

    const cart = this.data.cart
    const chosen = this.data.items
      .filter(i => cart[i._id] > 0)
      .map(i => ({
        item_id: i._id, name: i.name, price: i.price,
        unit: i.unit || '', count: cart[i._id]
      }))

    wx.setStorageSync(CART_KEY, {
      shopId: this.data.shop._id,
      shopName: this.data.shop.name,
      items: chosen,
      subtotal: this.data.cartSubtotal,
      shop_wechat: this.data.shop.contact_wechat
    })

    wx.navigateTo({ url: '/pages/foodcheckout/foodcheckout' })
  },

  // 从转发卡片冷启动进来的，退无可退，给个往下逛的出口
  goToShopList: function () {
    wx.reLaunch({ url: '/pages/shoplist/shoplist' })
  },

  // 转发封面用商品实拍图：比店铺 logo 勾人，也比微信自动截的界面图好。
  // 趁用户还在翻商品列表先下到本地，点转发时就不用等跨太平洋那一趟（见 utils/share.js）
  prefetchCover: function () {
    const dish = (this.data.items || []).filter(i => i.available && i.image)[0]
    this.coverID = (dish && dish.image) || (this.data.shop || {}).logo || ''
    this.cover = toLocalPath(this.coverID)
  },

  // 店长把自家店发到群里拉客，买家也会顺手转给室友——标题第一位是店名，
  // 第二位就是截单时间：群里的人要先确定「今天还赶得上吗」才会点进来。
  onShareAppMessage: function () {
    const shop = this.data.shop
    // 商品还没加载出来就点了转发，只能先转发店长列表
    if (!shop) return { title: '明尼助手 · 校外小店', path: '/pages/shoplist/shoplist' }

    const tail = shop.status === 'paused'
      ? '已打烊，可以先看看商品'
      : cutoffPhrase(this.batches) || '下单后到服务地点自取'

    return withCover({
      title: clip(shop.name, NAME_MAX) + ' · ' + tail,
      path: '/pages/shopdetail/shopdetail?id=' + shop._id
    }, this.coverID, this.cover)
  }
})
