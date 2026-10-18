const { t } = require('../../i18n/index.js')

const PAGE_SIZE = 20   // 和 wikiBrowse 一致

// 某个分类下的词条列表，分页加载
Page({
  data: {
    items: [],
    loading: true,
    loadingMore: false,
    noMore: false
  },

  onLoad: function (options) {
    this.categoryId = options.id
    if (options.name) {
      wx.setNavigationBarTitle({ title: decodeURIComponent(options.name) })
    }
    this.loadMore()
  },

  loadMore: function () {
    if (this.data.loadingMore || this.data.noMore) return
    this.setData({ loadingMore: true })
    wx.cloud.callFunction({
      name: 'wikiBrowse',
      data: { action: 'list', categoryId: this.categoryId, skip: this.data.items.length }
    }).then(res => {
      const r = res.result || {}
      if (!r.success) throw new Error(r.message || 'fail')
      this.setData({
        items: this.data.items.concat(r.items),
        noMore: r.noMore,
        loading: false,
        loadingMore: false
      })
    }).catch(() => {
      this.setData({ loading: false, loadingMore: false })
      wx.showToast({ title: t('加载失败，请稍后再试'), icon: 'none' })
    })
  },

  onReachBottom: function () {
    this.loadMore()
  },

  onTapArticle: function (e) {
    wx.navigateTo({ url: '/pages/wikidetail/wikidetail?id=' + e.currentTarget.dataset.id })
  }
})
