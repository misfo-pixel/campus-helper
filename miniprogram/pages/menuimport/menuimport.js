// 从网页导入菜单（流程见 cloudfunctions/menuImport 开头）。
// 这页先拿一个导入码，商家在浏览器里打开 minnepal.com/import 输入，AI 整理好交回来以后，
// 这页轮询到了就列出来，商家勾选、改价，过内容审核后一次上架。
const { checkContent } = require('../../utils/contentCheck.js')
const { t, f } = require('../../i18n/index.js')

const IMPORT_URL = 'minnepal.com/import'
const POLL_MS = 3000
// 审核接口一次最多 2500 字，留点余量
const CHECK_CHUNK = 2000

// 把所有商品的文字拼成不超过 CHECK_CHUNK 的几段，逐段送审
function chunkTexts(items) {
  const chunks = []
  let cur = ''
  items.forEach(i => {
    const line = [i.name, i.description, i.category, i.unit].filter(Boolean).join(' ')
    if (cur && (cur + '\n' + line).length > CHECK_CHUNK) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? cur + '\n' + line : line.slice(0, CHECK_CHUNK)
  })
  if (cur) chunks.push(cur)
  return chunks
}

// 分批送审，一次并发 5 批（150 件约 19 批，串行要跨太平洋 19 趟）。有一批不过就停，弹出原因
async function checkAll(chunks) {
  for (let k = 0; k < chunks.length; k += 5) {
    const results = await Promise.all(chunks.slice(k, k + 5).map(text => checkContent({ texts: [text] })))
    const bad = results.find(r => !r.pass)
    if (bad) {
      wx.hideLoading()
      wx.showModal({
        title: t('内容未通过审核'),
        content: t(bad.reason || '内容可能包含违规信息，请修改后重新提交'),
        showCancel: false,
        confirmText: t('我知道了')
      })
      return false
    }
  }
  return true
}

Page({
  data: {
    stage: 'starting',     // starting / waiting / expired / ready
    code: '',
    codeText: '',          // 'K7M 4QX'，分两段好念
    url: IMPORT_URL,
    items: [],             // [{ name, price, priceText, unit, description, category, restricted, picked }]
    pickedCount: 0,
    saving: false
  },

  onLoad: function () {
    this.start()
  },

  onShow: function () {
    if (this.data.stage === 'waiting') this.startPolling()
  },

  onHide: function () {
    this.stopPolling()
  },

  onUnload: function () {
    this.stopPolling()
  },

  start: function () {
    this.setData({ stage: 'starting' })
    wx.cloud.callFunction({ name: 'menuImport', data: { action: 'start' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '生成失败'), icon: 'none' })
        return
      }
      this.importId = r.importId
      this.setData({
        stage: 'waiting',
        code: r.code,
        codeText: r.code.slice(0, 3) + ' ' + r.code.slice(3)
      })
      this.startPolling()
    }).catch(err => {
      console.error('生成导入码失败：', err)
      wx.showToast({ title: t('生成失败，请重试'), icon: 'none' })
    })
  },

  startPolling: function () {
    this.stopPolling()
    this.timer = setInterval(() => this.poll(), POLL_MS)
  },

  stopPolling: function () {
    clearInterval(this.timer)
    this.timer = null
  },

  poll: function () {
    if (this.polling || !this.importId) return
    this.polling = true
    wx.cloud.callFunction({ name: 'menuImport', data: { action: 'poll', importId: this.importId } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) return
      if (r.expired) {
        this.stopPolling()
        this.setData({ stage: 'expired' })
      } else if (r.status === 'ready') {
        this.stopPolling()
        this.showItems(r.items || [])
      }
    }).catch(() => {}).then(() => {
      this.polling = false
    })
  },

  showItems: function (list) {
    const items = list.map(i => Object.assign({}, i, {
      priceText: i.price == null ? '' : String(i.price),
      // 没价格的先不勾，免得一路点下去导进去一堆 $0
      picked: !i.restricted && i.price != null
    }))
    this.setData({ stage: 'ready', items: items, pickedCount: items.filter(i => i.picked).length })
    wx.vibrateShort({ type: 'light' })
  },

  copyUrl: function () {
    wx.setClipboardData({ data: 'https://' + IMPORT_URL })
  },

  copyCode: function () {
    wx.setClipboardData({ data: this.data.code })
  },

  togglePick: function (e) {
    const i = e.currentTarget.dataset.index
    const item = this.data.items[i]
    if (item.restricted) return
    this.setData({
      ['items[' + i + '].picked']: !item.picked,
      pickedCount: this.data.pickedCount + (item.picked ? -1 : 1)
    })
  },

  togglePickAll: function () {
    const all = this.data.items.every(i => i.restricted || i.picked)
    const items = this.data.items.map(i => Object.assign({}, i, { picked: !i.restricted && !all }))
    this.setData({ items: items, pickedCount: items.filter(i => i.picked).length })
  },

  onPriceInput: function (e) {
    this.setData({ ['items[' + e.currentTarget.dataset.index + '].priceText']: e.detail.value })
  },

  commit: async function () {
    if (this.data.saving) return
    const picked = this.data.items
      .map((item, index) => ({ item: item, index: index }))
      .filter(p => p.item.picked)
    if (!picked.length) {
      wx.showToast({ title: t('请至少选一件'), icon: 'none' })
      return
    }
    const noPrice = picked.find(p => !(Number(p.item.priceText) >= 0) || p.item.priceText === '')
    if (noPrice) {
      wx.showToast({ title: f('「{0}」还没填价格', noPrice.item.name), icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: t('审核中...'), mask: true })
    try {
      if (!(await checkAll(chunkTexts(picked.map(p => p.item))))) return
      wx.showLoading({ title: t('导入中...'), mask: true })
      const res = await wx.cloud.callFunction({
        name: 'menuImport',
        data: {
          action: 'commit',
          importId: this.importId,
          picks: picked.map(p => ({ index: p.index, price: Number(p.item.priceText) }))
        }
      })
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '导入失败'), icon: 'none' })
        return
      }
      wx.showToast({ title: f('已导入 {0} 件', r.count), icon: 'success' })
      setTimeout(() => wx.navigateBack(), 900)
    } catch (err) {
      wx.hideLoading()
      console.error('导入失败：', err)
      wx.showToast({ title: t('导入失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  }
})
