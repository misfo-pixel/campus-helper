const { KINDS, isDemand } = require('../../utils/kinds.js')
const { stashFrom } = require('../../utils/preview.js')
const { shouldReload } = require('../../utils/refresh.js')
const { timedDb, timedCall } = require('../../utils/timing.js')
const { DEBUG_TIMING } = require('../../config.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const CFG = KINDS.item
const PAGE_SIZE = 20    // 小程序端单次 get 的硬上限就是 20 条，要更多只能分批拿

// 用户输入的关键词会被当成正则送进数据库，里面的 . * ( ) 等字符必须先转义，
// 否则搜个 "C++" 就会让查询报错甚至匹配出奇怪的结果
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 第一页列表在手机本地存一份，下次进来先摆上去、后台再拉最新的（stale-while-revalidate，见 utils/listCache.js）。
// 只缓存「没搜索」时的第一页：搜索词千变万化，命中率低，还会越存越多。key 按出/收分开
const LIST_CACHE_KEY = 'marketFirstPage.v1.'

Page({
  data: {
    items: [],
    keyword: '',
    kind: CFG.default,
    kinds: CFG.tabs,
    demand: false,
    emptyText: CFG.tabs[0].empty,
    loading: true,        // 首屏
    loadingMore: false,   // 正在拿下一页
    noMore: false         // 已经到底了
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
    if (shouldReload('item', this.loadedAt)) this.reload()
  },

  onTapKind: function (e) {
    const kind = e.currentTarget.dataset.key
    if (kind === this.data.kind) return
    // 之前敲字留下的防抖定时器要掐掉，否则 300ms 后它会再 reload 一次
    clearTimeout(this.searchTimer)
    const tab = CFG.tabs.filter(t => t.key === kind)[0]
    this.setData({
      kind: kind,
      demand: isDemand(kind),
      emptyText: tab.empty,
      keyword: ''         // 换面就清搜索，否则会看到「搜到 0 条」的假象
    })
    this.reload()
  },

  // 从头拿第一页。有缓存就先显示缓存、不出「加载中」，fetch(0) 回来后整页替换。
  reload: function () {
    const cached = this.data.keyword ? null : readCache(LIST_CACHE_KEY + this.data.kind)
    this.revalidating = !!cached
    this.setData({ items: cached || [], loading: !cached, loadingMore: false, noMore: false })
    this.fetch(0)
  },

  // 滑到底部时微信会自动调这个（页面级生命周期，不用自己监听滚动）
  onReachBottom: function () {
    // 后台刷新还没回来时不翻页：手里的第一页是缓存，拿它的条数去 skip 会跟新数据错位；
    // 而且翻页请求会领走新序号，把正在路上的刷新结果当成过期的丢掉。
    if (this.data.loading || this.data.loadingMore || this.data.noMore || this.revalidating) return
    this.setData({ loadingMore: true })
    this.fetch(this.data.items.length)
  },

  fetch: function (skip) {
    // 每次请求领一个号，响应回来时只认最新的号。
    // 不这么做的话：快速切换或连续输入时，先发的请求可能后到，把新数据覆盖掉。
    this.seq = (this.seq || 0) + 1
    const seq = this.seq

    // 响应回来时用户可能已经换了面，写缓存要按「发请求时」的 kind 记
    const kind = this.data.kind
    const cacheable = skip === 0 && !this.data.keyword

    const db = wx.cloud.database()
    const where = { status: 'on_sale', kind: kind }

    // 搜索放到服务端做。留在前端过滤的话，只能过滤已经加载的那几页，
    // 第 3 页里的匹配项永远搜不到——分页和前端搜索是天然冲突的。
    if (this.data.keyword) {
      where.title = db.RegExp({ regexp: escapeRegExp(this.data.keyword), options: 'i' })
    }

    // 两种布局用的字段不一样：求购没有图，但要显示描述。只取用得上的。
    const field = this.data.demand
      ? { title: true, price: true, description: true }
      : { title: true, price: true, images: true, thumb: true }

    // 同一时刻顺带打一次 ping 作对照。
    // 为什么要「同时」：两个数要在相同的网络条件下测才有可比性。
    // 隔几分钟分别测 ping 和查询，中间 WiFi 可能已经变了，差值就没意义了。
    // 这叫配对采样（paired sampling），比分别测两组数可靠得多。
    if (DEBUG_TIMING && skip === 0) {
      timedCall('ping', {}).catch(() => {})
    }

    // 这一条走的是「直连数据库」通道，跟云函数不是同一条路，要单独计时
    timedDb('market.list', () => db.collection('secondhand_items')
      .where(where)
      .field(field)
      .orderBy('created_at', 'desc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get())
      .then(res => {
        if (seq !== this.seq) return   // 已经有更新的请求发出去了，这份作废
        if (skip === 0) {
          // 成功时也要记时间。原来只在失败分支里记，onShow 永远以为「从没加载过」，
          // 每次从详情页返回都会清空重拉，用户滑到第几页都得从头来
          this.loadedAt = Date.now()
          this.revalidating = false
          if (cacheable) writeCache(LIST_CACHE_KEY + kind, res.data)
        }
        this.setData({
          items: skip === 0 ? res.data : this.data.items.concat(res.data),
          loading: false,
          loadingMore: false,
          // 拿回来不满一页，说明后面没有了
          noMore: res.data.length < PAGE_SIZE
        })
      })
      .catch(err => {
        console.error('加载失败：', err)
        if (seq !== this.seq) return
        if (skip === 0) {
          this.loadedAt = Date.now()
          this.revalidating = false   // 网络挂了，缓存留在屏幕上继续用
        }
        this.setData({ loading: false, loadingMore: false })
      })
  },

  onSearchInput: function (e) {
    this.setData({ keyword: e.detail.value.trim() })
    // 防抖：打字时每个字符都发一次请求太浪费，停手 300ms 才真正去查
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.reload(), 300)
  },

  onUnload: function () {
    clearTimeout(this.searchTimer)
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('item', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/itemdetail/itemdetail?id=' + id })
  }
})
