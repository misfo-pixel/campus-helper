const { stashFrom } = require('../../utils/preview.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const CACHE_KEY = 'taskList.v1.open'   // 先显示上次的，再刷新（见 utils/listCache.js）

Page({
  data: {
    items: []
  },

  // 先把上次存的摆上去，onShow 里的查询回来再整页换掉
  onLoad: function () {
    const cached = readCache(CACHE_KEY)
    if (cached) this.setData({ items: cached })
  },

  onShow: function () {
    const db = wx.cloud.database()
    db.collection('task_items')
      .where({ status: 'open' })
      // 只取列表用得上的，联系方式、地点这些进详情页再拿。
      // 图片列表里不显示，但带上它们详情页就能秒开出首图（见 utils/preview.js）
      .field({ title: true, reward: true, description: true, deadline: true, images: true, thumb: true })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        writeCache(CACHE_KEY, res.data)
        this.setData({ items: res.data })
      })
      .catch(err => {
        console.error('加载失败：', err)
      })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('task', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/taskdetail/taskdetail?id=' + id })
  },

  goToPublish: function () {
    wx.navigateTo({ url: '/pages/taskpublish/taskpublish' })
  }
})