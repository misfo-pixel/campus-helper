const { t } = require('../../i18n/index.js')

// 生活百科首页：搜索框 + 分类入口 + 最近更新 / 热门词条。
// 数据只走 wikiBrowse 云函数（集合对客户端不可读，draft 在服务端就拦掉了）。
Page({
  data: {
    categories: [],
    recent: [],
    hot: [],
    loading: true
  },

  onLoad: function () {
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'wikiBrowse',
      data: { action: 'home' }
    }).then(res => {
      const r = res.result || {}
      if (!r.success) throw new Error(r.message || 'fail')
      this.setData({ categories: r.categories, recent: r.recent, hot: r.hot, loading: false })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: t('加载失败，请稍后再试'), icon: 'none' })
    })
  },

  onSearchFocus: function () {
    wx.navigateTo({ url: '/pages/wikisearch/wikisearch' })
  },

  onTapCategory: function (e) {
    const { id, name } = e.currentTarget.dataset
    wx.navigateTo({ url: '/pages/wikilist/wikilist?id=' + id + '&name=' + encodeURIComponent(name) })
  },

  onTapArticle: function (e) {
    wx.navigateTo({ url: '/pages/wikidetail/wikidetail?id=' + e.currentTarget.dataset.id })
  },

  onShareAppMessage: function () {
    return { title: t('明尼生活百科'), path: '/pages/wiki/wiki' }
  }
})
