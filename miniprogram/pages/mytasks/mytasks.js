const { closedLabel, openLabel } = require('../../utils/kinds.js')
const { stashFrom } = require('../../utils/preview.js')
const { retryStuckReviews } = require('../../utils/publish.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const CACHE_KEY = 'myTasks.v1.all'   // 先显示上次的，再刷新（见 utils/listCache.js）

// 库里的 status 是英文枚举（open / done），原样显示用户看不懂，这里换成中文。
// 缓存里存原始字段，派生字段每次现算
function decorate(list) {
  return list.map(it => Object.assign({}, it, {
    statusText: closedLabel('task', it) || openLabel('task', it)
  }))
}

const app = getApp()

Page({
  data: {
    items: []
  },

  // 先把上次存的摆上去，onShow 里的查询回来再整页换掉
  onLoad: function () {
    const cached = readCache(CACHE_KEY)
    if (cached) this.setData({ items: decorate(cached) })
  },

  onShow: function () {
    // 复用 app.js 启动时的登录结果，不再打 login 云函数
    app.globalData.profileReady.then(profile => {
      if (!profile) return
      return wx.cloud.database().collection('task_items')
        .where({ _openid: profile.openid })
        .orderBy('created_at', 'desc')
        .get()
        .then(res => {
          // 卡在审核中的（送审请求没发出去之类）补审一次，没通过会弹窗
          retryStuckReviews('task', res.data)
          writeCache(CACHE_KEY, res.data)
          this.setData({ items: decorate(res.data) })
        })
    }).catch(err => console.error('加载失败：', err))
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('task', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/taskdetail/taskdetail?id=' + id })
  }
})