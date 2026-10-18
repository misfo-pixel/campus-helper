const { t } = require('../../i18n/index.js')

// 百科搜索：简单模糊匹配（标题/标签/摘要），没结果时引导去反馈页告诉我们想查什么。
// 每次搜索（包括没结果的）都由 wikiBrowse 写进 wiki_search_logs，作为选题来源。
Page({
  data: {
    q: '',
    items: [],
    searched: false,
    searching: false
  },

  onInput: function (e) {
    this.setData({ q: e.detail.value })
  },

  onSearch: function () {
    const q = this.data.q.trim()
    if (!q || this.data.searching) return
    this.setData({ searching: true })
    wx.cloud.callFunction({
      name: 'wikiBrowse',
      data: { action: 'search', q: q }
    }).then(res => {
      const r = res.result || {}
      if (!r.success) throw new Error(r.message || 'fail')
      this.setData({ items: r.items, searched: true, searching: false })
    }).catch(() => {
      this.setData({ searching: false })
      wx.showToast({ title: t('加载失败，请稍后再试'), icon: 'none' })
    })
  },

  onTapArticle: function (e) {
    wx.navigateTo({ url: '/pages/wikidetail/wikidetail?id=' + e.currentTarget.dataset.id })
  },

  // 没找到 → 去意见反馈页告诉我们想查什么（Phase 2 会换成词条内提交建议）
  onGoFeedback: function () {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  }
})
