const { markStale } = require('../../utils/refresh.js')
const { takePreview } = require('../../utils/preview.js')
const { prefetchCover, detailShare } = require('../../utils/share.js')
const { closedLabel, reviewHint } = require('../../utils/kinds.js')

const app = getApp()

Page({
  data: {
    item: null,
    canDelete: false,
    isOwner: false,
    seller: { nickname: '', avatarUrl: '' },
    closed: '',          // 已结束时顶部横幅上的字（已售出 / 已结束 / 已过期…），还开着就是空串
    loading: true,       // 必须从 true 开始：第一帧 item 还是 null，不写的话 wxml 会直接落到「已下架」分支
    notFound: false,
    isRootPage: false,   // 从分享卡片冷启动进来时页面栈只有这一页，没有上一页可返回
    partial: false,      // 首屏先用列表带过来的数据画，getDetail 回来之前只有图、标题、价格可信
    shownUpTo: 1         // 轮播只加载到第几张（见 onSwiperChange）
  },

  // 点卖家头像进 TA 的主页，直接停在本板块那一页
  // 内容没了时给个出口。冷启动进来的页面栈只有一页，navigateBack 是空操作。
  goToMarket: function () {
    wx.reLaunch({ url: '/pages/taskmarket/taskmarket' })
  },

  // 用 seller.uid（users 文档的随机 id），不要用 openid——链接会被转发出去
  goToSellerStore: function () {
    const uid = this.data.seller && this.data.seller.uid
    if (!uid) return
    wx.navigateTo({ url: '/pages/userstore/userstore?uid=' + uid + '&tab=task' })
  },

  // 没有这个函数，右上角菜单里的「转发」就是灰的。标题模板和封面预下载见 utils/share.js
  onShareAppMessage: function () {
    return detailShare('task', this.data.item, this.cover)
  },

  // 轮播只加载看到的这张和下一张。一进来就同时拉 6 张原图，会和首图抢带宽，首图反而出来得慢
  onSwiperChange: function (e) {
    const next = e.detail.current + 1
    if (next > this.data.shownUpTo) this.setData({ shownUpTo: next })
  },

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

    const id = options.id
    if (!id) return this.setData({ loading: false, notFound: true })

    // 从列表点进来的，先用列表里那条画首屏（图、标题、价格），不用白屏等下面这趟往返
    const pre = takePreview('task', id)
    if (pre) this.setData({ item: pre, partial: true })

    // 一次调用拿齐三样：内容、发布者资料、我能不能删。
    // 原来是三趟串行往返，跨太平洋一趟约 0.3 秒，合并后省掉 0.6 秒。
    // 而且 _openid 在云函数里就被摘掉了，不会下发到前端。
    wx.cloud.callFunction({ name: 'getDetail', data: { type: 'task', id: id } })
      .then(res => {
        const r = (res && res.result) || {}
        if (!r.success) return this.setData({ item: null, partial: false, loading: false, notFound: true })
        this.setData({
          item: r.item,
          closed: closedLabel('task', r.item),
          reviewHint: reviewHint(r.item),
          seller: r.seller,
          isOwner: r.isOwner,
          canDelete: r.canDelete,
          partial: false,
          loading: false
        })
        this.cover = prefetchCover(r.item, r.isOwner)   // 趁用户还在看，先把转发封面下好
      })
      .catch(err => {
        console.error('加载详情失败：', err)
        this.setData({ item: null, partial: false, loading: false, notFound: true })
      })
  },

  // 标记已完成（发布者）
  markDone: function () {
    wx.showModal({
      title: '确认已完成',
      content: '标记后任务将下架，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('task_items').doc(this.data.item._id).update({
            data: { status: 'done' }
          }).then(() => {
            markStale('task')   // 返回列表时要看到这次改动
            // 从分享卡片冷启动进来时 navigateBack 退不回去，页面会留在这儿，得当场换成已结束的样子
            const item = Object.assign({}, this.data.item, { status: 'done' })
            this.setData({ item: item, closed: closedLabel('task', item) })
            wx.showToast({ title: '已标记完成', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('标记失败：', err)
            wx.showToast({ title: '操作失败', icon: 'none' })
          })
        }
      }
    })
  },

  deleteItem: function () {
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('task_items').doc(this.data.item._id).remove().then(() => {
            markStale('task')   // 返回列表时要看到这次改动
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('删除失败：', err)
            wx.showToast({ title: '删除失败', icon: 'none' })
          })
        }
      }
    })
  }
})