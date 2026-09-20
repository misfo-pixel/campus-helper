// 某个用户的公开主页，聚合他在三个板块发布的内容。
//
// 数据统一走 getUserStore 云函数，前端只拿着一个不透明的 uid（users 文档的随机 _id）。
// openid 全程留在服务端——这个页面的链接会被转发给陌生人，不能带永久身份标识。
const { isDemand, rentText } = require('../../utils/kinds.js')
const { thumbOf } = require('../../utils/thumb.js')
const { toLocalPath } = require('../../utils/poster.js')
const { withCover } = require('../../utils/share.js')
const { stashPreview } = require('../../utils/preview.js')
const { readCache, writeCache } = require('../../utils/listCache.js')

const app = getApp()

const LABELS = { item: '闲置', sublet: '转租', task: '任务' }
const DETAIL = {
  item: '/pages/itemdetail/itemdetail',
  sublet: '/pages/subletdetail/subletdetail',
  task: '/pages/taskdetail/taskdetail'
}
const TAB_ORDER = ['all', 'item', 'sublet', 'task']
const UNITS = { item: '条', sublet: '条', task: '个' }
const PAGE_LIMIT = 20   // 跟 getUserStore 云函数里的一致：每类最多返回这么多
// 按 uid 各存一份，先显示再刷新（见 utils/listCache.js）。逛过的人多了只留最近 10 个
const CACHE_KEY = 'userStore.v1.'
const CACHE_KEEP = 10

// 转发标题要有信息量：「我发布了 3 条闲置、1 条转租」比「在明尼助手的闲置」
// 更能让群里的人点进来。每类最多拉 20 条，拉满就写 20+，不假装精确。
function countPhrase(buckets, keys) {
  return keys
    .filter(k => buckets[k].length > 0)
    .map(k => {
      const n = buckets[k].length
      return (n >= PAGE_LIMIT ? PAGE_LIMIT + '+' : n) + ' ' + UNITS[k] + LABELS[k]
    })
    .join('、')
}

// 三种记录字段各不相同，先抹平成同一个形状，模板就只用写一套
function normalize(type, doc) {
  const image = thumbOf(doc)
  const cover = (doc.images && doc.images[0]) || ''   // 转发封面要大图，缩略图放大会糊
  // 同一个页签里「在卖」和「求购」会混着排，价格得能分辨出是要价还是预算
  const demand = isDemand(doc.kind)
  const money = demand ? '预算 $' : '$'

  if (type === 'sublet') {
    return {
      _id: doc._id, type: 'sublet', label: demand ? '求租' : LABELS.sublet, image: image, cover: cover,
      title: doc.title,
      price: money + rentText(doc) + '/月',
      sub: [doc.room_type, doc.address].filter(Boolean).join(' · ')
    }
  }
  if (type === 'task') {
    return {
      _id: doc._id, type: 'task', label: LABELS.task, image: image, cover: cover,
      title: doc.title,
      price: '$' + doc.reward,
      sub: doc.deadline ? '截止 ' + doc.deadline : ''
    }
  }
  return {
    _id: doc._id, type: 'item', label: demand ? '求购' : LABELS.item, image: image, cover: cover,
    title: doc.title,
    price: money + doc.price,
    sub: ''
  }
}

Page({
  data: {
    uid: '',
    seller: { nickname: '', avatarUrl: '' },
    tab: 'all',
    tabs: [],
    shown: [],
    total: 0,
    loading: true,
    notFound: false,
    isMe: false
  },

  onLoad: function (options) {
    // 两种进入方式：普通转发链接带 uid；扫小程序码进来的参数在 scene 里，
    // 而且是 URL 编码过的，必须解一次码。漏了这一步扫码就永远打不开。
    let uid = options.uid || ''
    if (!uid && options.scene) {
      try {
        uid = decodeURIComponent(options.scene)
      } catch (e) {
        uid = options.scene
      }
    }
    const tab = LABELS[options.tab] ? options.tab : 'all'
    this.setData({ uid: uid, tab: tab })

    if (!uid) return this.setData({ loading: false, notFound: true })

    // 逛过的主页先把上次存的摆上去，getUserStore 回来再整页换掉
    const cached = readCache(CACHE_KEY + uid)
    if (cached) this.render(cached)

    wx.cloud.callFunction({ name: 'getUserStore', data: { uid: uid } })
      .then(res => {
        const r = (res && res.result) || {}
        // 查无此人（注销了、链接是坏的）：就算有缓存也不能再展示
        if (!r.success) return this.setData({ loading: false, notFound: true })
        writeCache(CACHE_KEY + uid, { seller: r.seller, buckets: r.buckets }, CACHE_KEEP)
        this.render(r)
      })
      .catch(err => {
        console.error('加载主页失败：', err)
        // 网络挂了但手上有缓存，就继续用缓存
        if (!this.buckets) this.setData({ loading: false, notFound: true })
      })

    // 是不是自己看自己，只影响一句空状态文案，不挡列表
    if (app.globalData && app.globalData.profileReady) {
      app.globalData.profileReady.then(profile => {
        if (profile && profile.uid && profile.uid === uid) {
          this.setData({ isMe: true })
          this.coverID = null                      // 认出是主人了，封面换成原图重下
          this.coverOf((this.data.shown || [])[0])
        }
      })
    }
  },

  // 把 getUserStore 的结果（或上次缓存的同一份）画出来
  render: function (r) {
    const b = r.buckets || {}
    // 列表显示用的是抹平过的形状，详情页秒开要原始字段，另存一份（不进 setData，不占渲染）
    this.raw = {}
    ;['item', 'sublet', 'task'].forEach(k => (b[k] || []).forEach(d => { this.raw[d._id] = d }))
    this.buckets = {
      item: (b.item || []).map(d => normalize('item', d)),
      sublet: (b.sublet || []).map(d => normalize('sublet', d)),
      task: (b.task || []).map(d => normalize('task', d))
    }
    this.setData({ seller: r.seller || {}, loading: false })
    this.applyTab(this.data.tab)
    wx.setNavigationBarTitle({ title: ((r.seller || {}).nickname || '同学') + '的主页' })
  },

  applyTab: function (tab) {
    const b = this.buckets || { item: [], sublet: [], task: [] }
    const all = b.item.concat(b.sublet, b.task)
    const shown = tab === 'all' ? all : b[tab]

    const tabs = TAB_ORDER.map(key => ({
      key: key,
      label: key === 'all' ? '全部' : LABELS[key],
      count: key === 'all' ? all.length : b[key].length
    }))

    this.setData({ tab: tab, shown: shown, tabs: tabs, total: all.length })
    this.coverOf(shown[0])
  },

  // 转发封面提前下到本地（同 share.js 的 prefetchCover）：
  // 主人自己转发是在打广告，下原图；别人来逛的多、转发的少，下 30KB 的缩略图就够
  coverOf: function (first) {
    const fileID = (first && first.cover) || ''
    if (fileID !== this.coverID) {
      this.coverID = fileID
      this.cover = toLocalPath(this.data.isMe ? fileID : (first.image || fileID))
    }
    return fileID
  },

  onTapTab: function (e) {
    this.applyTab(e.currentTarget.dataset.key)
  },

  goToDetail: function (e) {
    const ds = e.currentTarget.dataset
    stashPreview(ds.type, (this.raw || {})[ds.id])   // 详情页先拿它画首屏，不白屏等网络
    wx.navigateTo({ url: DETAIL[ds.type] + '?id=' + ds.id })
  },

  goToMarket: function () {
    wx.reLaunch({ url: '/pages/market/market' })
  },

  // 分享当前页签：停在「转租」时分享出去，别人点开也停在「转租」。
  // 页面本身无状态，靠 URL 参数还原。
  onShareAppMessage: function () {
    const name = this.data.seller.nickname || '同学'
    const tab = this.data.tab
    const b = this.buckets || { item: [], sublet: [], task: [] }
    const counts = countPhrase(b, tab === 'all' ? ['item', 'sublet', 'task'] : [tab])
    // 还没加载完或者这一类是空的，就退回不带数字的说法
    const title = counts
      ? name + ' 发布了 ' + counts + '，来看看吧'
      : name + ' 在明尼助手' + (tab === 'all' ? '发布的内容' : ('的' + LABELS[tab]))
    // 不指定 imageUrl 的话，微信会自动截页面顶部——截到的是头像和页签，
    // 一张灰白的界面图。拿第一件商品的实拍图当封面，群里刷到直观得多。
    const fileID = this.coverOf((this.data.shown || [])[0])
    return withCover({
      title: title,
      path: '/pages/userstore/userstore?uid=' + this.data.uid +
            (tab === 'all' ? '' : '&tab=' + tab)
    }, fileID, this.cover)
  }
})
