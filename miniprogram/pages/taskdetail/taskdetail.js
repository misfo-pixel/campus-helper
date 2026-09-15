const { markStale } = require('../../utils/refresh.js')

const app = getApp()

Page({
  data: {
    item: null,
    canDelete: false,
    isOwner: false,
    seller: { nickname: '', avatarUrl: '' }
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

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

    const id = options.id
    if (!id) return this.setData({ loading: false, notFound: true })

    // 一次调用拿齐三样：内容、发布者资料、我能不能删。
    // 原来是三趟串行往返，跨太平洋一趟约 0.3 秒，合并后省掉 0.6 秒。
    // 而且 _openid 在云函数里就被摘掉了，不会下发到前端。
    wx.cloud.callFunction({ name: 'getDetail', data: { type: 'task', id: id } })
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