const { markStale } = require('../../utils/refresh.js')

const { timedCall } = require('../../utils/timing.js')

const app = getApp()

Page({
  data: {
    item: null,
    isOwner: false,
    canDelete: false,
    seller: { nickname: '', avatarUrl: '' },
    loading: true,
    notFound: false,
    isRootPage: false    // 从分享卡片冷启动进来时页面栈只有这一页，没有上一页可返回
  },

  deleteItem: function () {
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定吗？',
      success: (res) => {
        if (res.confirm) {
          wx.cloud.callFunction({
            name: 'deleteItem',
            data: { itemId: this.data.item._id }   // 传要删的商品id
          }).then(res => {
            if (res.result.success) {
              markStale('item')   // 返回列表时要看到这次改动
              wx.showToast({ title: '已删除', icon: 'success' })
              setTimeout(() => wx.navigateBack(), 1000)
            } else {
              wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
            }
          }).catch(err => {
            console.error('删除失败：', err)
            wx.showToast({ title: '删除失败', icon: 'none' })
          })
        }
      }
    })
  },

  markSold: function () {
    wx.showModal({
      title: '确认已售',
      content: '标记后商品将从市场下架，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('secondhand_items').doc(this.data.item._id).update({
            data: { status: 'sold' }
          }).then(() => {
            markStale('item')   // 返回列表时要看到这次改动
            wx.showToast({ title: '已标记售出', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('标记失败：', err)
            wx.showToast({ title: '操作失败', icon: 'none' })
          })
        }
      }
    })
  },

  // 点卖家头像进 TA 的主页，直接停在「闲置」那一页。
  // 用 seller.uid（users 文档的随机 id），不要用 openid——链接会被转发出去。
  goToSellerStore: function () {
    const uid = this.data.seller && this.data.seller.uid
    if (!uid) return
    wx.navigateTo({ url: '/pages/userstore/userstore?uid=' + uid + '&tab=item' })
  },

  // 商品没了的时候给个出口。冷启动进来的页面栈只有一页，navigateBack 是空操作，
  // 所以这里用 reLaunch 而不是 navigateTo，免得把废弃的详情页留在栈里。
  goToMarket: function () {
    wx.reLaunch({ url: '/pages/market/market' })
  },

  // 转发单件商品，落地页就是详情本身
  onShareAppMessage: function () {
    const item = this.data.item
    if (!item) return { title: '明尼助手 · 二手市场', path: '/pages/market/market' }
    return {
      title: item.title + ' · $' + item.price,
      imageUrl: (item.images && item.images[0]) || '',
      path: '/pages/itemdetail/itemdetail?id=' + item._id
    }
  },

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

    const id = options.id
    if (!id) return this.setData({ loading: false, notFound: true })

    // 一次调用拿齐三样：内容、发布者资料、我能不能删。
    // 原来是三趟串行往返，跨太平洋一趟约 0.3 秒，合并后省掉 0.6 秒。
    // 而且 _openid 在云函数里就被摘掉了，不会下发到前端。
    timedCall('getDetail', { type: 'item', id: id })
      .then(res => {
        const r = (res && res.result) || {}
        if (!r.success) return this.setData({ loading: false, notFound: true })
        this.setData({
          item: r.item,
          seller: r.seller,
          isOwner: r.isOwner,
          canDelete: r.canDelete,
          loading: false
        })
      })
      .catch(err => {
        console.error('加载详情失败：', err)
        this.setData({ loading: false, notFound: true })
      })
  }
})
