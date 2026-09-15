// 某个用户的公开主页，聚合他在三个板块发布的内容。
//
// 数据统一走 getUserStore 云函数，前端只拿着一个不透明的 uid（users 文档的随机 _id）。
// openid 全程留在服务端——这个页面的链接会被转发给陌生人，不能带永久身份标识。
const { isDemand } = require('../../utils/kinds.js')

const app = getApp()

const LABELS = { item: '闲置', sublet: '转租', task: '任务' }
const DETAIL = {
  item: '/pages/itemdetail/itemdetail',
  sublet: '/pages/subletdetail/subletdetail',
  task: '/pages/taskdetail/taskdetail'
}
const TAB_ORDER = ['all', 'item', 'sublet', 'task']

// 三种记录字段各不相同，先抹平成同一个形状，模板就只用写一套
function normalize(type, doc) {
  const image = (doc.images && doc.images[0]) || ''
  // 同一个页签里「在卖」和「求购」会混着排，价格得能分辨出是要价还是预算
  const demand = isDemand(doc.kind)
  const money = demand ? '预算 $' : '$'

  if (type === 'sublet') {
    return {
      _id: doc._id, type: 'sublet', label: demand ? '求租' : LABELS.sublet, image: image,
      title: doc.title,
      price: money + doc.rent + '/月',
      sub: [doc.room_type, doc.address].filter(Boolean).join(' · ')
    }
  }
  if (type === 'task') {
    return {
      _id: doc._id, type: 'task', label: LABELS.task, image: image,
      title: doc.title,
      price: '$' + doc.reward,
      sub: doc.deadline ? '截止 ' + doc.deadline : ''
    }
  }
  return {
    _id: doc._id, type: 'item', label: demand ? '求购' : LABELS.item, image: image,
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

    wx.cloud.callFunction({ name: 'getUserStore', data: { uid: uid } })
      .then(res => {
        const r = (res && res.result) || {}
        if (!r.success) return this.setData({ loading: false, notFound: true })

        const b = r.buckets || {}
        this.buckets = {
          item: (b.item || []).map(d => normalize('item', d)),
          sublet: (b.sublet || []).map(d => normalize('sublet', d)),
          task: (b.task || []).map(d => normalize('task', d))
        }
        this.setData({ seller: r.seller || {}, loading: false })
        this.applyTab(this.data.tab)
        wx.setNavigationBarTitle({ title: (r.seller.nickname || '同学') + '的主页' })
      })
      .catch(err => {
        console.error('加载主页失败：', err)
        this.setData({ loading: false, notFound: true })
      })

    // 是不是自己看自己，只影响一句空状态文案，不挡列表
    if (app.globalData && app.globalData.profileReady) {
      app.globalData.profileReady.then(profile => {
        if (profile && profile.uid && profile.uid === uid) this.setData({ isMe: true })
      })
    }
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
  },

  onTapTab: function (e) {
    this.applyTab(e.currentTarget.dataset.key)
  },

  goToDetail: function (e) {
    const ds = e.currentTarget.dataset
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
    const what = tab === 'all' ? '发布的内容' : ('的' + LABELS[tab])
    // 不指定 imageUrl 的话，微信会自动截页面顶部——截到的是头像和页签，
    // 一张灰白的界面图。拿第一件商品的实拍图当封面，群里刷到直观得多。
    const first = (this.data.shown || [])[0]
    return {
      title: name + ' 在明尼助手' + what,
      imageUrl: (first && first.image) || '',
      path: '/pages/userstore/userstore?uid=' + this.data.uid +
            (tab === 'all' ? '' : '&tab=' + tab)
    }
  }
})
