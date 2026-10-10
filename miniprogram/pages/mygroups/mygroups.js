const { KINDS, closedLabel, openLabel } = require('../../utils/kinds.js')
const { stashFrom } = require('../../utils/preview.js')
const { retryStuckReviews } = require('../../utils/publish.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const CACHE_KEY = 'myGroups.v1.all'   // 先显示上次的，再刷新（见 utils/listCache.js）

const LABEL = {}
KINDS.group.tabs.forEach(t => { LABEL[t.key] = t.label })

// 缓存里存原始字段，派生字段每次现算
function decorate(list) {
  return list.map(it => Object.assign({}, it, {
    kindLabel: LABEL[it.kind || KINDS.group.default],
    statusText: closedLabel('group', it) || openLabel('group', it)
  }))
}

const app = getApp()

Page({
  data: {
    items: [],
    loading: true   // 没缓存的第一次进来先转圈，别先闪一下「还没有」
  },

  onLoad: function () {
    const cached = readCache(CACHE_KEY)
    if (cached) this.setData({ items: decorate(cached), loading: false })
  },

  onShow: function () {
    // 复用 app.js 启动时的登录结果，不再打 login 云函数
    app.globalData.profileReady.then(profile => {
      if (!profile) return this.setData({ loading: false })
      return wx.cloud.database().collection('group_items')
        .where({ _openid: profile.openid })
        .orderBy('created_at', 'desc')
        .get()
        .then(res => {
          retryStuckReviews('group', res.data)
          writeCache(CACHE_KEY, res.data)
          this.setData({ items: decorate(res.data), loading: false })
        })
    }).catch(err => {
      console.error('加载失败：', err)
      this.setData({ loading: false })
    })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('group', this.data.items, id)
    wx.navigateTo({ url: '/pages/groupdetail/groupdetail?id=' + id })
  }
})
