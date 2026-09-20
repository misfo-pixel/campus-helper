const { KINDS, isDemand, closedLabel, openLabel, rentText } = require('../../utils/kinds.js')
const { stashFrom } = require('../../utils/preview.js')
const { retryStuckReviews } = require('../../utils/publish.js')
const { shouldReload } = require('../../utils/refresh.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const CFG = KINDS.sublet
const PAGE_SIZE = 20
const CACHE_KEY = 'mySublets.v1.'   // 按页签分开存第一页，先显示再刷新（见 utils/listCache.js）

// 库里的 status 是英文枚举（on_sale 之类），原样显示用户看不懂，这里换成中文。
// 缓存里存原始字段，派生字段每次现算，缓存和新数据走同一条路
function decorate(list) {
  return list.map(it => Object.assign({}, it, {
      statusText: closedLabel('sublet', it) || openLabel('sublet', it),
      rentText: rentText(it)
  }))
}
const app = getApp()

Page({
  data: {
    items: [],
    openid: '',
    kind: CFG.default,
    kinds: CFG.tabs,
    demand: false,
    loading: true,
    loadingMore: false,
    noMore: false
  },

  onLoad: function () {
    this.firstShow = true
    this.reload()
  },

  // 分页之后不能无脑重拉：那会把用户滑了好几页的进度清掉。
  // 只有别处改了数据（发布/删除/改状态打了标记），或者放太久了，才从头拉。
  onShow: function () {
    // 首次进入时 onLoad 和 onShow 会连着触发。onLoad 已经拉过一次了，
    // 而那次请求还没回来、loadedAt 还没赋值，这里再判断就会"以为从没加载过"
    // 又拉一遍——每次进页面发两次一模一样的请求。所以第一次必须跳过。
    if (this.firstShow) {
      this.firstShow = false
      return
    }
    if (shouldReload('sublet', this.loadedAt)) this.reload()
  },

  onTapKind: function (e) {
    const kind = e.currentTarget.dataset.key
    if (kind === this.data.kind) return
    this.setData({ kind: kind, demand: isDemand(kind) })
    this.reload()
  },

  // 有缓存就先摆上去、不出「加载中」，fetch(0) 回来后整页替换
  reload: function () {
    const cached = readCache(CACHE_KEY + this.data.kind)
    this.revalidating = !!cached
    this.setData({ items: cached ? decorate(cached) : [], loading: !cached, loadingMore: false, noMore: false })
    this.fetch(0)
  },

  onReachBottom: function () {
    // 后台刷新还没回来时不翻页：手里的第一页是缓存，拿它的条数去 skip 会跟新数据错位
    if (this.data.loading || this.data.loadingMore || this.data.noMore || this.revalidating) return
    this.setData({ loadingMore: true })
    this.fetch(this.data.items.length)
  },

  fetch: function (skip) {
    this.seq = (this.seq || 0) + 1
    const seq = this.seq
    const kind = this.data.kind

    // 复用 app.js 启动时的登录结果，不再打 login 云函数
    app.globalData.profileReady.then(profile => {
      if (!profile) return
      if (seq !== this.seq) return
      this.setData({ openid: profile.openid })

      return wx.cloud.database().collection('sublet_items')
        .where({ _openid: profile.openid, kind: kind })   // 只查我发的这一面
        .orderBy('created_at', 'desc')
        .skip(skip)
        .limit(PAGE_SIZE)
        .get()
        .then(res => {
          if (seq !== this.seq) return
          // 卡在审核中的（送审请求没发出去之类）补审一次，没通过会弹窗
          retryStuckReviews('sublet', res.data)
          if (skip === 0) {
            // 原来从没给 loadedAt 赋过值，onShow 里 shouldReload 永远以为「从没加载过」，
            // 每次从详情页返回都清空重拉，滑到第几页都得从头来（市场页修过同一个 bug）
            this.loadedAt = Date.now()
            this.revalidating = false
            writeCache(CACHE_KEY + kind, res.data)
          }
          const rows = decorate(res.data)
          this.setData({
            items: skip === 0 ? rows : this.data.items.concat(rows),
            loading: false,
            loadingMore: false,
            noMore: res.data.length < PAGE_SIZE
          })
        })
    }).catch(err => {
      console.error('加载失败：', err)
      if (seq !== this.seq) return
      if (skip === 0) {
        this.loadedAt = Date.now()
        this.revalidating = false   // 网络挂了，缓存留在屏幕上继续用
      }
      this.setData({ loading: false, loadingMore: false })
    })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('sublet', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/subletdetail/subletdetail?id=' + id })
  }
})
