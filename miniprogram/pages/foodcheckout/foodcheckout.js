// 确认订单。
//
// 这一页不做任何支付动作，只是把订单记下来，然后告诉买家该往哪转账。
// 钱走小程序外，商家收到之后在工作台点「接单」。
//
// 买家到取餐点自取，不送到公寓门口。
// 取餐点和批次由实际送货的一方定（商家自送用店铺的，外包用配送队的），
// 这里统一通过 shopBrowse 的 plan 拿解析结果，不用关心是哪一方。
// 商家自己送还是外包给配送队，对买家是透明的——规则完全一样。

const { fetchMyProfile } = require('../../utils/user.js')
const { ensureContentOk } = require('../../utils/contentCheck.js')

const CART_KEY = 'foodCart'

Page({
  data: {
    cart: null,
    loading: true,

    points: [],
    pointLabels: [],
    pointIndex: null,

    batches: [],
    batchLabels: [],
    batchIndex: 0,

    contact_wechat: '',
    note: '',

    deliveryFee: 0,
    total: 0,
    submitting: false
  },

  onLoad: function () {
    const cart = wx.getStorageSync(CART_KEY)
    if (!cart || !cart.items || cart.items.length === 0) {
      wx.showModal({
        title: '购物车是空的',
        content: '请先回去选菜',
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }

    // 单行小计在这里算好。放到 WXML 里做乘法会露出浮点尾巴（12.6×3 = 37.800000000000004）
    cart.items = cart.items.map(i => Object.assign({}, i, {
      lineTotal: Math.round(i.price * i.count * 100) / 100
    }))
    this.setData({ cart: cart })

    wx.cloud.callFunction({
      name: 'shopBrowse',
      data: { action: 'plan', shopId: cart.shopId }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: '读取配送配置失败', icon: 'none' })
        return
      }

      const points = r.pickup_points || []
      const batches = r.availableBatches || []
      if (!points.length || !batches.length) {
        this.setData({ loading: false })
        wx.showModal({
          title: '暂时无法下单',
          content: '这家店还没设置好取餐点或配送时间，请稍后再试。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }

      this.setData({
        points: points,
        pointLabels: points.map(p => p.name + '  $' + p.fee),
        batches: batches,
        batchLabels: batches.map(b => this.batchLabel(b)),
        batchIndex: 0,
        loading: false
      }, () => this.recalc())
    }).catch(err => {
      console.error('读取配送配置失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取配送配置失败', icon: 'none' })
    })

    // 微信号自动填个人资料里存的那个
    fetchMyProfile().then(profile => {
      if (profile.wechat && !this.data.contact_wechat) {
        this.setData({ contact_wechat: profile.wechat })
      }
    }).catch(err => console.error('读取微信号失败：', err))
  },

  // 「午餐班 · 今天 12:00 到点（还有 47 分钟截单）」
  batchLabel: function (b) {
    const when = b.isToday ? '今天' : '明天'
    let s = b.label + ' · ' + when + ' ' + b.deliver_time + ' 到点'
    if (b.isToday && b.minutesLeft != null) {
      s += b.minutesLeft >= 60
        ? '（还有 ' + Math.floor(b.minutesLeft / 60) + ' 小时截单）'
        : '（还有 ' + b.minutesLeft + ' 分钟截单）'
    } else {
      s += '（' + b.cutoff + ' 截单）'
    }
    return s
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onPointChange: function (e) {
    this.setData({ pointIndex: Number(e.detail.value) }, () => this.recalc())
  },

  onBatchChange: function (e) {
    this.setData({ batchIndex: Number(e.detail.value) })
  },

  recalc: function () {
    const idx = this.data.pointIndex
    const fee = idx === null ? 0 : (Number(this.data.points[idx].fee) || 0)
    const total = Math.round((this.data.cart.subtotal + fee) * 100) / 100
    this.setData({ deliveryFee: fee, total: total })
  },

  submit: async function () {
    const d = this.data
    if (d.submitting) return

    if (d.pointIndex === null) {
      wx.showToast({ title: '请选择取餐点', icon: 'none' })
      return
    }
    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: '请填写你的微信号', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    try {
      // 备注会被商家和配送员看到，属于 UGC
      if (!(await ensureContentOk({
        texts: [d.note, d.contact_wechat],
        scene: 2
      }))) return

      const batch = d.batches[d.batchIndex]
      const res = await wx.cloud.callFunction({
        name: 'buyerOrders',
        data: {
          action: 'create',
          shopId: d.cart.shopId,
          items: d.cart.items.map(i => ({ item_id: i.item_id, count: i.count })),
          pickup_point: d.points[d.pointIndex].name,
          batch_key: batch.key,
          contact_wechat: d.contact_wechat,
          note: d.note
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '下单失败', icon: 'none' })
        return
      }

      wx.removeStorageSync(CART_KEY)

      wx.showModal({
        title: '订单已提交',
        content: '请通过 ' + (r.payment_note || '商家提供的方式') +
                 ' 向商家支付 $' + r.total + '。商家确认收到款后会接单。\n\n' +
                 '请在 ' + r.batch_date + ' ' + r.deliver_time + ' 到取餐点自取（' + r.batch_label + '）。\n\n' +
                 '平台不经手资金，请自行核对收款方信息。',
        showCancel: false,
        confirmText: '知道了',
        success: () => {
          wx.redirectTo({ url: '/pages/myfoodorders/myfoodorders' })
        }
      })
    } catch (err) {
      wx.hideLoading()
      console.error('下单失败：', err)
      wx.showToast({ title: '下单失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
