const { KINDS, isDemand, closedLabel, openLabel } = require('../../utils/kinds.js')
const { stashFrom } = require('../../utils/preview.js')
const { retryStuckReviews } = require('../../utils/publish.js')
const { shouldReload } = require('../../utils/refresh.js')
const { readCache, writeCache } = require('../../utils/listCache.js')
const { toLocalPath } = require('../../utils/poster.js')
const { showPoster } = require('../../utils/groupCover.js')
const { currentPromo } = require('../../utils/promo.js')
const { withCover, withPromo, storeTitle } = require('../../utils/share.js')
const { t, f } = require('../../i18n/index.js')

const CFG = KINDS.item
const PAGE_SIZE = 20
const CACHE_KEY = 'myItems.v1.'   // 按页签分开存第一页，先显示再刷新（见 utils/listCache.js）

// 库里的 status 是英文枚举（on_sale 之类），原样显示用户看不懂，这里换成中文。
// 缓存里存原始字段，派生字段每次现算，缓存和新数据走同一条路
function decorate(list) {
  return list.map(it => Object.assign({}, it, {
      statusText: closedLabel('item', it) || openLabel('item', it)
  }))
}
const app = getApp()

Page({
  data: {
    items: [],
    uid: '',
    nickname: '',
    avatarUrl: '',
    posterBusy: false,
    onSaleCount: 0,     // 转发标题用：公开主页上能看到几条
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
    if (shouldReload('item', this.loadedAt)) this.reload()
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
      this.setData({
        uid: profile.uid || '',
        nickname: profile.nickname || '',
        avatarUrl: profile.avatarUrl || ''
      })

      // 转发出去的是公开主页，那边列的是在售+求购两面，所以不按当前页签数。
      // 列表是分页的，数已加载的会少，单独 count 一次。失败只影响转发文案。
      if (skip === 0) {
        this.loadHot(profile.uid)
        wx.cloud.database().collection('secondhand_items')
          .where({ _openid: profile.openid, status: 'on_sale' })
          .count()
          .then(r => { if (seq === this.seq) this.setData({ onSaleCount: r.total }) })
          .catch(() => {})
      }

      return wx.cloud.database().collection('secondhand_items')
        .where({ _openid: profile.openid, kind: kind })   // 只查我发的这一面
        .orderBy('created_at', 'desc')
        .skip(skip)
        .limit(PAGE_SIZE)
        .get()
        .then(res => {
          if (seq !== this.seq) return
          // 卡在审核中的（送审请求没发出去之类）补审一次，没通过会弹窗
          retryStuckReviews('item', res.data)
          if (skip === 0) {
            // 原来从没给 loadedAt 赋过值，onShow 里 shouldReload 永远以为「从没加载过」，
            // 每次从详情页返回都清空重拉，滑到第几页都得从头来（市场页修过同一个 bug）
            this.loadedAt = Date.now()
            this.revalidating = false
            writeCache(CACHE_KEY + kind, res.data)
          }
          const rows = decorate(res.data)
          // 转发封面趁现在就下到本地，点转发时不用再跨太平洋现拉。
          // 自己转发自己的主页是在打广告，用原图
          if (skip === 0) this.coverOf(rows)
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

  // 海报是给自己拿去传播的：一张长图，在售的闲置全部列出来，发群、发朋友圈、发小红书都行。
  // 不用 AI（卖闲置的人多，会把额度用光），配色从头像和商品照片里取，每个人的都不一样
  makePoster: function () {
    if (this.data.posterBusy) return
    const uid = this.data.uid
    if (!uid) {
      wx.showToast({ title: t('还没加载完，稍等再点'), icon: 'none' })
      return
    }

    this.setData({ posterBusy: true })
    wx.showLoading({ title: t('生成中…'), mask: true })
    const gs = this.selectComponent('#gs')

    Promise.all([
      wx.cloud.callFunction({ name: 'getUserStore', data: { uid: uid, poster: true } })
        .then(res => (((res && res.result) || {}).buckets || {}).item || []),
      // 小程序码要小程序发布过才拿得到，失败就画「搜明尼助手」，不影响出图
      wx.cloud.callFunction({ name: 'getMiniCode', data: { uid: uid } })
        .then(res => ((res && res.result) || {}).fileID || '')
        .catch(() => '')
    ]).then(([items, qr]) => {
      // 求购的不上海报：海报是摆摊，不是找东西
      const onSale = items.filter(it => !isDemand(it.kind))
      if (!onSale.length) {
        wx.hideLoading()
        this.setData({ posterBusy: false })
        wx.showToast({ title: t('还没有在售的闲置'), icon: 'none' })
        return
      }
      const pic = it => it.thumb || (it.images && it.images[0]) || ''
      return gs.themeFromPhotos([this.data.avatarUrl].concat(onSale.slice(0, 4).map(pic))).then(theme => gs.long({
        theme: theme,
        title: f('{0}的闲置', this.data.nickname || t('明大同学')),
        subtitle: f('在售 {0} 件，看中直接聊', onSale.length),
        logo: this.data.avatarUrl,
        tag: f('{0} 件', onSale.length),
        when: null,
        info: [t('扫码看详情、加卖家微信')],
        sections: [{ title: '', items: onSale.map(it => ({ image: pic(it), name: it.title, price: it.price })) }],
        qrFileID: qr,
        promo: currentPromo(),
        footer: t('二手市场 · 明尼助手')
      })).then(path => {
        wx.hideLoading()
        this.setData({ posterBusy: false })
        showPoster(path)
      })
    }).catch(err => {
      console.error('生成海报失败：', err)
      wx.hideLoading()
      this.setData({ posterBusy: false })
      wx.showToast({ title: t('生成失败，请重试'), icon: 'none' })
    })
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    stashFrom('item', this.data.items, id)   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: '/pages/itemdetail/itemdetail?id=' + id })
  },

  // 先看看别人点开分享会看到什么，再决定要不要发出去。
  //
  // uid 原本只在列表加载成功后才写进 data，列表还没回来（或请求失败）时点这个按钮
  // 会静默 return，看起来就是「按钮坏了」。所以这里自己去取一次 uid，
  // 拿不到再明确提示，不留哑按钮。
  previewStore: function () {
    const go = uid => {
      wx.navigateTo({
        url: '/pages/userstore/userstore?uid=' + uid + '&tab=item',
        fail: err => {
          console.error('打开主页失败：', err)
          wx.showToast({ title: t('打开失败，请重试'), icon: 'none' })
        }
      })
    }

    if (this.data.uid) return go(this.data.uid)

    const cached = (app.globalData.profile || {}).uid
    if (cached) {
      this.setData({ uid: cached })
      return go(cached)
    }

    // profileReady 可能直接 resolve 出本地缓存，而上个版本写的缓存里没有 uid。
    // 所以缓存那份没 uid 时，再等一次走网络的 profileFresh。
    wx.showLoading({ title: t('加载中') })
    app.globalData.profileReady
      .then(profile => (profile && profile.uid) ? profile : app.globalData.profileFresh)
      .then(profile => {
        wx.hideLoading()
        const uid = (profile && profile.uid) || ''
        if (!uid) {
          wx.showToast({ title: t('资料还没加载好，请稍后再试'), icon: 'none' })
          return
        }
        this.setData({ uid: uid })
        go(uid)
      }).catch(err => {
        wx.hideLoading()
        console.error('获取用户资料失败：', err)
        wx.showToast({ title: t('网络异常，请重试'), icon: 'none' })
      })
  },

  // 第一件在售商品的首图，和它下到本地的 Promise。换了一件才重新下载
  // 转发用最可能卖掉的那件：标题写它的信息，封面用它的图（挑法见 getUserStore 的 hot_item）
  loadHot: function (uid) {
    if (!uid) return
    wx.cloud.callFunction({ name: 'getUserStore', data: { uid: uid } }).then(res => {
      const r = (res && res.result) || {}
      const items = ((r.buckets || {}).item || []).filter(it => !isDemand(it.kind))
      this.hot = items.find(it => it._id === r.hot_item) || null
      this.hotCount = items.length
      if (this.hot) this.coverOf([Object.assign({ status: 'on_sale' }, this.hot)])
    }).catch(err => console.warn('挑转发封面失败：', err))
  },

  coverOf: function (items) {
    const first = (items || []).filter(it => it.status === 'on_sale')[0]
    const fileID = (first && first.images && first.images[0]) || ''
    if (fileID !== this.coverID) {
      this.coverID = fileID
      this.cover = withPromo(this.selectComponent('#gs'), toLocalPath(fileID))
    }
    return fileID
  },

  // 分享出去的是公开主页，不是这一页——这一页含已售和下架的，只该自己看
  onShareAppMessage: function () {
    // 老缓存里没有 uid（缓存是上个版本写的），拿不到就退回市场页，
    // 不要退回到带 openid 的旧链接
    if (!this.data.uid) {
      return { title: t('明尼助手 · 二手市场'), path: '/pages/market/market' }
    }
    // 有最可能卖掉的那件：标题就是它的信息，封面是它的图。没有就退回第一件在售的
    if (this.hot) {
      const fileID = this.coverOf([Object.assign({ status: 'on_sale' }, this.hot)])
      return withCover({
        title: storeTitle(this.hot, this.hotCount),
        path: '/pages/userstore/userstore?uid=' + this.data.uid + '&tab=item'
      }, fileID, this.cover)
    }
    const fileID = this.coverOf(this.data.items)
    const n = this.data.onSaleCount
    return withCover({
      title: n > 0 ? f('我发布了 {0} 条闲置，来看看吧', n) : t('我在明尼助手上架的闲置，来看看'),
      path: '/pages/userstore/userstore?uid=' + this.data.uid + '&tab=item'
    }, fileID, this.cover)
  }
})
