// 店铺详情 + 点单。
//
// 选好的商品只在这一页存活，点「去拼团」时写进 storage 交给下单页。
// 前端算的金额只用来显示，真正的总价由 buyerOrders 云函数按数据库当前价重算。
//
// 一家店可能同时开着几场（不同日子），顶上切换；买的东西不分场次，下单时跟着选中的那一场走。
// 从转发卡片进来的带着 s（场次）和 from=share，默认选中那一场，下单时记一笔来源。
// 扫海报上的小程序码进来的只带 scene（场次 ID，放不下店铺 ID），来源记 poster。
//
// 页面、转发卡片、长图海报都按这家店的配色来（从 logo 取色，风格是店长挑的，见 utils/theme.js）。
// 转发卡片是现画的：卖得最多的那道菜 + 广告语 + 进度。选中场次一变就重画一张备着，
// 点转发时直接用，不用等。

const { withCover } = require('../../utils/share.js')
const { toLocalPath } = require('../../utils/poster.js')
const { ORDERING_ENABLED } = require('../../config.js')
const { TEMPLATES, askOrGuide } = require('../../utils/subscribe.js')
const { md, weekday, cutoffText, progress, shareTitle, ownerTitle, cardData, longData } = require('../../utils/group.js')
const { cssVars } = require('../../utils/theme.js')
const { showPoster } = require('../../utils/groupCover.js')
const { t, f } = require('../../i18n/index.js')

const CART_KEY = 'shopCart'

function decorate(s, now) {
  return Object.assign({}, s, {
    p: progress(s, false),
    dayText: md(s.date) + ' ' + weekday(s.date),
    cutText: cutoffText(s, now),
    cutHot: s.minutes_left != null && s.minutes_left < 180
  })
}

Page({
  data: {
    ordering: ORDERING_ENABLED,   // 黄页模式下整套购物车/下单都不出现
    loading: true,
    shop: null,
    items: [],
    groups: [],
    sessions: [],
    sessionIndex: 0,
    session: null,     // 选中的那一场
    cart: {},          // { itemId: count }
    cartCount: 0,
    cartSubtotal: 0,
    canOrder: false,   // 有场次 + 到起送价
    reachMin: false,
    isRootPage: false, // 从转发卡片冷启动进来时页面栈只有这一页，没有上一页可返回

    // 开团提醒。模板还没申请下来时整条不显示，免得点了没反应
    subEnabled: !!TEMPLATES.shopOpen,
    subTickets: 0,     // 还攒着几张票 = 还能收到几次开团提醒
    subMine: false,    // 自己的店不给自己订阅
    subBusy: false,
    posterBusy: false,
    themeStyle: ''     // 这家店的配色，CSS 变量写在页面根节点上
  },

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

    if (!options.id && !options.scene) {
      wx.showToast({ title: t('缺少店铺信息'), icon: 'none' })
      return
    }
    this.shopId = options.id || ''
    this.wantSession = options.s || ''
    this.source = options.from === 'share' ? 'share' : ''
    // 扫海报上的码：scene 就是场次 ID
    if (options.scene) {
      this.wantSession = decodeURIComponent(options.scene)
      this.source = 'poster'
    }
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'shopBrowse',
      data: { action: 'detail', shopId: this.shopId, sessionId: this.wantSession }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showModal({
          title: t('打不开这家店'),
          content: t(r.message || '店铺不存在'),
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }
      const sub = r.subscription || {}
      const sessions = (r.sessions || []).map(x => decorate(x, r.now))
      const want = sessions.findIndex(x => x._id === this.wantSession)
      const index = want >= 0 ? want : 0
      this.setData({
        shop: r.shop,
        items: r.items || [],
        sessions: sessions,
        sessionIndex: index,
        session: sessions[index] || null,
        loading: false,
        subTickets: sub.tickets || 0,
        subMine: sub.isMine === true
      }, () => {
        this.shopId = r.shop._id
        this.rebuild()
        this.prefetchCover()
        this.applyTheme()
      })
    }).catch(err => {
      console.error('读取店铺失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
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
      canOrder: !!this.data.session && count > 0 && reachMin
    })
  },

  pickSession: function (e) {
    const i = Number(e.currentTarget.dataset.index)
    this.setData({ sessionIndex: i, session: this.data.sessions[i] }, () => {
      this.rebuild()
      this.prepareCard()
    })
  },

  // 选中那一场的转发卡片主图，画好备着。画失败就用商品图兜底（prefetchCover）
  // 这家店的配色。取完色才画卡片，不然卡片会先用兜底配色画一张
  applyTheme: function () {
    const gs = this.selectComponent('#gs')
    if (!gs) return
    gs.themeFor(this.data.shop).then(theme => {
      this.theme = theme
      this.setData({ themeStyle: cssVars(theme) })
      this.prepareCard()
    }).catch(err => console.warn('取店铺配色失败：', err))
  },

  prepareCard: function () {
    const s = this.data.session
    this.cardPath = ''
    if (!s) return
    const gs = this.selectComponent('#gs')
    if (!gs) return
    const id = s._id
    gs.card(cardData(this.data.shop, s, this.data.items, this.theme))
      .then(p => {
        if (this.data.session && this.data.session._id === id) this.cardPath = p
      })
      .catch(err => console.warn('转发卡片没画出来，用商品图：', err))
  },

  // 长图海报：菜全部列出来，存图、发朋友圈、发小红书。
  // 小程序码要小程序发布过才拿得到，拿不到就画「搜明尼助手」
  makePoster: function () {
    const s = this.data.session
    if (!s || this.data.posterBusy) return
    this.setData({ posterBusy: true })
    wx.showLoading({ title: t('生成中…'), mask: true })
    wx.cloud.callFunction({ name: 'getMiniCode', data: { sessionId: s._id } })
      .then(res => ((res && res.result) || {}).fileID || '')
      .catch(() => '')
      .then(qr => this.selectComponent('#gs').long(longData(this.data.shop, s, this.data.items, this.theme, qr)))
      .then(path => {
        wx.hideLoading()
        showPoster(path)
      })
      .catch(err => {
        console.error('生成海报失败：', err)
        wx.hideLoading()
        wx.showToast({ title: t('生成失败，请重试'), icon: 'none' })
      })
      .then(() => this.setData({ posterBusy: false }))
  },

  addItem: function (e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find(i => i._id === id)
    if (!item || !item.available) return

    if (!this.data.session) {
      wx.showToast({ title: t('暂无拼团，可以订阅开团提醒'), icon: 'none' })
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

  // 开团提醒。微信的订阅消息是一次性的：点一次「允许」只能收一条，
  // 所以这里是「攒票」——每点一次多一次提醒，收到一次少一次（见 cloudfunctions/shopSubscribe）。
  //
  // askOrGuide 必须是这个点击里的第一个调用，前面不能有任何 await，
  // 否则真机上授权弹窗弹不出来。
  subscribe: function () {
    if (this.data.subBusy) return
    askOrGuide('shopOpen').then(ok => {
      if (!ok) return
      this.setData({ subBusy: true })
      return wx.cloud.callFunction({
        name: 'shopSubscribe',
        data: { action: 'subscribe', shopId: this.shopId }
      }).then(res => {
        const r = (res && res.result) || {}
        if (!r.success) {
          wx.showToast({ title: t(r.message || '订阅失败'), icon: 'none' })
          return
        }
        this.setData({ subTickets: r.tickets })
        wx.showToast({ title: t('下次开团会通知你'), icon: 'none' })
      })
    }).catch(err => {
      console.error('订阅开团提醒失败：', err)
      wx.showToast({ title: t('订阅失败，请重试'), icon: 'none' })
    }).then(() => this.setData({ subBusy: false }))
  },

  unsubscribe: function () {
    wx.showModal({
      title: t('取消开团提醒'),
      content: t('之后这家店开团就不再通知你了'),
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'shopSubscribe',
          data: { action: 'unsubscribe', shopId: this.shopId }
        }).then(r2 => {
          const r = (r2 && r2.result) || {}
          if (r.success) this.setData({ subTickets: 0 })
          else wx.showToast({ title: t(r.message || '操作失败'), icon: 'none' })
        }).catch(err => {
          console.error('取消开团提醒失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  // 黄页模式下买家唯一的动作：把店长微信复制走，自己去微信谈
  copyWechat: function () {
    const wechat = (this.data.shop || {}).contact_wechat
    if (!wechat) return
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: t('已复制微信号'), icon: 'success' })
    })
  },

  // 店名旁的「证」标：直接看店长传的原图。previewImage 认云文件 ID，不用先换临时链接
  previewLicense: function () {
    const url = (this.data.shop || {}).license_image
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  checkout: function () {
    if (!this.data.session) {
      wx.showToast({ title: t('暂无拼团'), icon: 'none' })
      return
    }
    if (this.data.cartCount === 0) {
      wx.showToast({ title: t('还没选商品'), icon: 'none' })
      return
    }
    if (!this.data.reachMin) {
      wx.showToast({ title: f('还没到起送价 ${0}', this.data.shop.min_order), icon: 'none' })
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
      sessionId: this.data.session._id,
      source: this.source,
      items: chosen,
      subtotal: this.data.cartSubtotal,
      shop_wechat: this.data.shop.contact_wechat
    })

    wx.navigateTo({ url: '/pages/shopcheckout/shopcheckout' })
  },

  // 从转发卡片冷启动进来的，退无可退，给个往下逛的出口
  goToShopList: function () {
    wx.reLaunch({ url: '/pages/shoplist/shoplist' })
  },

  // 转发封面用商品实拍图：比店铺 logo 勾人，也比微信自动截的界面图好。
  // 趁用户还在翻商品列表先下到本地，点转发时就不用等跨太平洋那一趟（见 utils/share.js）
  prefetchCover: function () {
    const product = (this.data.items || []).filter(i => i.available && i.image)[0]
    this.coverID = (product && product.image) || (this.data.shop || {}).logo || ''
    this.cover = toLocalPath(this.coverID)
  },

  // 店长把自家店发到群里拉客，买家也会顺手转给室友。标题按选中那一场的进度写
  //（「还差 3 位！」「只差 1 位！」），落地直接定位到这一场
  onShareAppMessage: function () {
    const shop = this.data.shop
    // 商品还没加载出来就点了转发，只能先转发列表
    if (!shop) return { title: t('一起拼团 · 满单成团，送到学校'), path: '/pages/shoplist/shoplist' }

    const s = this.data.session
    // 店长转自己的店是在打广告，标题用他写的广告语；别人转用进度
    const title = !s ? f('{0} · 订阅开团提醒', shop.name) : (this.data.subMine ? ownerTitle(shop, s) : shareTitle(shop.name, s, false))
    const path = '/pages/shopdetail/shopdetail?id=' + shop._id + (s ? '&s=' + s._id : '') + '&from=share'
    if (this.cardPath) return { title: title, path: path, imageUrl: this.cardPath }
    return withCover({ title: title, path: path }, this.coverID, this.cover)
  }
})
