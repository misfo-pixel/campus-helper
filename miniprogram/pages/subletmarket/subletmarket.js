const { KINDS, isDemand } = require('../../utils/kinds.js')
const { shouldReload } = require('../../utils/refresh.js')

const CFG = KINDS.sublet
const PAGE_SIZE = 20

Page({
  data: {
    items: [],
    kind: CFG.default,
    kinds: CFG.tabs,
    demand: false,
    emptyText: CFG.tabs[0].empty,
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
    const tab = CFG.tabs.filter(t => t.key === kind)[0]
    this.setData({ kind: kind, demand: isDemand(kind), emptyText: tab.empty })
    this.reload()
  },

  reload: function () {
    this.setData({ items: [], loading: true, loadingMore: false, noMore: false })
    this.fetch(0)
  },

  onReachBottom: function () {
    if (this.data.loading || this.data.loadingMore || this.data.noMore) return
    this.setData({ loadingMore: true })
    this.fetch(this.data.items.length)
  },

  fetch: function (skip) {
    this.seq = (this.seq || 0) + 1
    const seq = this.seq

    // 求租帖没有房源图，但要显示想找的区域和描述
    const field = this.data.demand
      ? { title: true, rent: true, address: true, room_type: true, description: true }
      : { title: true, rent: true, address: true, room_type: true, images: true, start_date: true }

    wx.cloud.database().collection('sublet_items')
      .where({ status: 'on_sale', kind: this.data.kind })
      .field(field)
      .orderBy('created_at', 'desc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()
      .then(res => {
        if (seq !== this.seq) return
        if (skip === 0) this.loadedAt = Date.now()
        this.setData({
          items: skip === 0 ? res.data : this.data.items.concat(res.data),
          loading: false,
          loadingMore: false,
          noMore: res.data.length < PAGE_SIZE
        })
      })
      .catch(err => {
        console.error('加载失败：', err)
        if (seq !== this.seq) return
        if (skip === 0) this.loadedAt = Date.now()
        this.setData({ loading: false, loadingMore: false })
      })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/subletdetail/subletdetail?id=' + id })
  },

  goToPublish: function () {
    wx.navigateTo({ url: '/pages/subletpublish/subletpublish' })
  }
})
