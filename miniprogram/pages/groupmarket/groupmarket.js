const { stashFrom } = require('../../utils/preview.js')
const { readCache, writeCache } = require('../../utils/listCache.js')
const { KINDS } = require('../../utils/kinds.js')
const { t } = require('../../i18n/index.js')
const { filterHidden } = require('../../utils/blocks.js')

const CACHE_KEY = 'groupList.v1.open'   // 先显示上次的，再刷新（见 utils/listCache.js）

// 搭子和长期群混在一个列表里，不像二手那样分两面：刚上线帖子少，
// 再一拆两边都显得空。每张卡片用胶囊标出是哪一种
const LABEL = {}
KINDS.group.tabs.forEach(t => { LABEL[t.key] = t.label })

function decorate(list) {
  return filterHidden('group', list).map(it => Object.assign({}, it, {
    kindLabel: LABEL[it.kind || KINDS.group.default]
  }))
}

Page({
  data: {
    items: [],
    loading: true   // 没缓存的第一次进来先转圈，别先闪一下「还没有」
  },

  // 先把上次存的摆上去，onShow 里的查询回来再整页换掉
  onLoad: function () {
    const cached = readCache(CACHE_KEY)
    if (cached) this.setData({ items: decorate(cached), loading: false })
  },

  onShow: function () {
    const db = wx.cloud.database()
    db.collection('group_items')
      .where({ status: 'open' })
      // 联系方式进详情页再拿。图片列表里只显示缩略图，带上原图详情页能秒开出首图（见 utils/preview.js）
      .field({ title: true, kind: true, description: true, event_date: true, location: true, images: true, thumb: true })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        writeCache(CACHE_KEY, res.data)
        this.setData({ items: decorate(res.data), loading: false })
      })
      .catch(err => {
        console.error('加载失败：', err)
        this.setData({ loading: false })
      })
  },

  onShareAppMessage: function () {
    return { title: t('明尼助手 · 找搭子、组乐队、兴趣群'), path: '/pages/groupmarket/groupmarket' }
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('group', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/groupdetail/groupdetail?id=' + id })
  },

  goToPublish: function () {
    wx.navigateTo({ url: '/pages/grouppublish/grouppublish' })
  }
})
