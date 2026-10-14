const { markStale } = require('../../utils/refresh.js')
const { takePreview } = require('../../utils/preview.js')
const { prefetchCover, detailShare } = require('../../utils/share.js')
const { KINDS, closedLabel, reviewHint } = require('../../utils/kinds.js')
const { t, f } = require('../../i18n/index.js')

function tabOf(item) {
  const kind = (item && item.kind) || KINDS.group.default
  return KINDS.group.tabs.filter(t => t.key === kind)[0] || KINDS.group.tabs[0]
}

Page({
  data: {
    item: null,
    kindLabel: '',
    closeText: '',       // 群主那颗按钮上的字：标记为已凑齐 / 标记为已停止招新
    canDelete: false,
    isOwner: false,
    seller: { nickname: '', avatarUrl: '' },
    closed: '',
    loading: true,       // 必须从 true 开始，理由见 taskdetail
    notFound: false,
    isRootPage: false,
    partial: false,
    shownUpTo: 1
  },

  goToMarket: function () {
    wx.reLaunch({ url: '/pages/groupmarket/groupmarket' })
  },

  // 用 seller.uid（users 文档的随机 id），不要用 openid——链接会被转发出去
  goToSellerStore: function () {
    const uid = this.data.seller && this.data.seller.uid
    if (!uid) return
    wx.navigateTo({ url: '/pages/userstore/userstore?uid=' + uid + '&tab=group' })
  },

  onShareAppMessage: function () {
    return detailShare('group', this.data.item, this.cover)
  },

  onSwiperChange: function (e) {
    const next = e.detail.current + 1
    if (next > this.data.shownUpTo) this.setData({ shownUpTo: next })
  },

  // 胶囊和按钮上的字只看 kind，列表带过来的预览里就有，首屏就能画
  labels: function (item) {
    const tab = tabOf(item)
    return { kindLabel: tab.label, closeText: f('标记为{0}', tab.closed) }
  },

  onLoad: function (options) {
    this.setData({ isRootPage: getCurrentPages().length === 1 })

    const id = options.id
    if (!id) return this.setData({ loading: false, notFound: true })

    const pre = takePreview('group', id)
    if (pre) this.setData(Object.assign({ item: pre, partial: true }, this.labels(pre)))

    wx.cloud.callFunction({ name: 'getDetail', data: { type: 'group', id: id } })
      .then(res => {
        const r = (res && res.result) || {}
        if (!r.success) return this.setData({ item: null, partial: false, loading: false, notFound: true })
        this.setData(Object.assign({
          item: r.item,
          closed: closedLabel('group', r.item),
          reviewHint: reviewHint(r.item),
          seller: r.seller,
          isOwner: r.isOwner,
          canDelete: r.canDelete,
          partial: false,
          loading: false
        }, this.labels(r.item)))
        this.cover = prefetchCover(r.item, r.isOwner)
      })
      .catch(err => {
        console.error('加载详情失败：', err)
        this.setData({ item: null, partial: false, loading: false, notFound: true })
      })
  },

  // 群主：凑齐了 / 不再招新。卡片从列表下架，群本身当然还在微信里
  markDone: function () {
    wx.showModal({
      title: t(this.data.closeText),
      content: t('标记后这条会从列表下架，确定吗？'),
      success: (res) => {
        if (!res.confirm) return
        const db = wx.cloud.database()
        db.collection('group_items').doc(this.data.item._id).update({
          data: { status: 'done' }
        }).then(() => {
          markStale('group')
          const item = Object.assign({}, this.data.item, { status: 'done' })
          this.setData({ item: item, closed: closedLabel('group', item) })
          wx.showToast({ title: t('已下架'), icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1000)
        }).catch(err => {
          console.error('标记失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  deleteItem: function () {
    wx.showModal({
      title: t('确认删除'),
      content: t('删除后无法恢复，确定吗？'),
      success: (res) => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'deleteItem',
          data: { type: 'group', itemId: this.data.item._id }
        }).then(res => {
          if (!res.result.success) {
            wx.showToast({ title: t(res.result.message || '删除失败'), icon: 'none' })
            return
          }
          markStale('group')
          wx.showToast({ title: t('已删除'), icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1000)
        }).catch(err => {
          console.error('删除失败：', err)
          wx.showToast({ title: t('删除失败'), icon: 'none' })
        })
      }
    })
  }
})
