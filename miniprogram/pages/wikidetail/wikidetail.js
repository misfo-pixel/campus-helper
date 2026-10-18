const { t } = require('../../i18n/index.js')
const wikiMd = require('../../utils/wikiMd.js')

// 词条详情：标题、摘要、正文（Markdown）、核实日期、来源、免责声明。
// 分享卡片标题 = 词条标题，点开直达本页（path 带 id）。
Page({
  data: {
    article: null,
    nodes: [],
    verifiedText: '',
    loading: true,
    notFound: false
  },

  onLoad: function (options) {
    this.id = options.id
    wx.cloud.callFunction({
      name: 'wikiBrowse',
      data: { action: 'detail', id: this.id, preview: options.preview === '1' }
    }).then(res => {
      const r = res.result || {}
      if (!r.success) {
        this.setData({ loading: false, notFound: true })
        return
      }
      const a = r.article
      this.setData({
        article: a,
        nodes: wikiMd.render(a.content),
        verifiedText: a.verifiedAt ? this.formatDate(a.verifiedAt) : '',
        loading: false
      })
      wx.setNavigationBarTitle({ title: a.title })
    }).catch(() => {
      this.setData({ loading: false, notFound: true })
    })
  },

  // verifiedAt 从云函数来是 Date 序列化后的字符串，按字符串拆，不过 Date 的时区
  formatDate: function (s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
    return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
  },

  // 来源链接：小程序里点不开外链，长按复制，自己去浏览器打开
  onCopySource: function (e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.url })
  },

  onShareAppMessage: function () {
    const a = this.data.article
    return {
      title: a ? a.title : t('明尼生活百科'),
      path: '/pages/wikidetail/wikidetail?id=' + this.id
    }
  },

  onShareTimeline: function () {
    const a = this.data.article
    return {
      title: a ? a.title + '｜' + a.summary : t('明尼生活百科'),
      query: 'id=' + this.id
    }
  }
})
