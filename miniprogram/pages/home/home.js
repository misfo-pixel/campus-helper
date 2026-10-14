const { SHOP_MODULE_ENABLED, GROUP_MODULE_ENABLED, SPONSORS_ENABLED } = require('../../config.js')
const { currentBanner } = require('../../utils/promo.js')
const { readCache, writeCache } = require('../../utils/listCache.js')
const { layoutTiles } = require('../../utils/tiles.js')
const { t, f } = require('../../i18n/index.js')

const SPONSOR_CACHE_KEY = 'sponsors.v1.active'   // 先显示上次的，再刷新（见 utils/listCache.js）

// 颜色跟着模块走，不跟着位置走：关掉某个模块时别的格子不会换色
const TILES = [
  { key: 'market', title: t('二手市场'), sub: t('低价淘，轻松出'), color: 'gold', url: '/pages/market/market' },
  { key: 'sublet', title: t('公寓转租'), sub: t('找房、转租、找室友'), color: '', url: '/pages/subletmarket/subletmarket' },
  { key: 'task', title: t('任务委托'), sub: t('代取、代购、跑腿'), color: 'maroon', url: '/pages/taskmarket/taskmarket' },
  { key: 'group', title: t('兴趣群组'), sub: t('找搭子、组乐队'), color: '', url: '/pages/groupmarket/groupmarket',
    enabled: GROUP_MODULE_ENABLED, sticker: t('新'), stickerUntil: '2026-11-10' },
  { key: 'shop', title: t('一起拼团'), sub: t('满单成团，送到学校'), color: 'cream', url: '/pages/shoplist/shoplist',
    enabled: SHOP_MODULE_ENABLED },
  { key: 'feedback', title: t('意见反馈'), sub: t('问题和建议都欢迎'), color: '', url: '/pages/feedback/feedback' }
]

Page({
  data: {
    tiles: [],
    banner: null,
    sponsorsEnabled: SPONSORS_ENABLED,
    sponsors: []
  },

  onLoad: function () {
    if (!SPONSORS_ENABLED) return
    const cached = readCache(SPONSOR_CACHE_KEY)
    if (cached) this.setData({ sponsors: cached })
  },

  // 横幅和「新」小标都按日期，放 onShow：小程序在后台挂几天再切回来，过期的要能自己消失
  onShow: function () {
    this.setData({ banner: currentBanner(), tiles: layoutTiles(TILES) })
    if (SPONSORS_ENABLED) this.loadSponsors()
  },

  loadSponsors: function () {
    wx.cloud.database().collection('sponsors')
      .where({ active: true })
      .field({ name: true, logo: true, link: true })
      .orderBy('order', 'asc')
      .limit(20)
      .get()
      .then(res => {
        writeCache(SPONSOR_CACHE_KEY, res.data)
        this.setData({ sponsors: res.data })
      })
      // 集合还没建（一个赞助商都没有）也走这里，只剩「等你加入」那一个，不用报错
      .catch(() => {})
  },

  onTapTile: function (e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  onTapBanner: function () {
    const banner = this.data.banner
    if (!banner) return
    // 有 id 的横幅有自己的活动页（pages/event），说明、步骤、按钮都在那里
    if (banner.id) {
      wx.navigateTo({ url: '/pages/event/event?id=' + banner.id })
    } else if (banner.wechat) {
      wx.showModal({
        title: t('活动详情'),
        content: f(banner.detail || '客服微信：{0}', banner.wechat),
        confirmText: t('复制微信号'),
        success: res => {
          if (!res.confirm) return
          wx.setClipboardData({
            data: banner.wechat,
            success: () => wx.showToast({ title: t('微信号已复制'), icon: 'success' })
          })
        }
      })
    } else if (banner.link) {
      wx.navigateTo({ url: banner.link })
    }
  },

  onTapSponsor: function (e) {
    const link = e.currentTarget.dataset.link
    if (link) wx.navigateTo({ url: link })
  },

  // 赞助洽谈走意见反馈：管理员本来就在看那个列表，不用在代码里写死谁的微信号
  onTapSponsorSlot: function () {
    wx.showModal({
      title: t('想在这里展示你的店？'),
      content: t('在意见反馈里留下店名和联系方式，我们会尽快联系你。'),
      confirmText: t('去留言'),
      success: res => {
        if (res.confirm) wx.navigateTo({ url: '/pages/feedback/feedback' })
      }
    })
  }
})
