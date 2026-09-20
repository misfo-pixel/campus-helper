// 确认订单。
//
// 这一页只把下单意向记下来：不做支付动作，也不展示任何收款方式。
// 店长在工作台看到订单后自己通过微信联系买家。
//
// 买家到服务地点自取，不送到公寓门口。
// 服务地点和批次由实际送货的一方定（店长自送用店铺的，外包用配送队的），
// 这里统一通过 shopBrowse 的 plan 拿解析结果，不用关心是哪一方。
// 店长自己送还是外包给配送队，对买家是透明的——规则完全一样。

const { myProfile } = require('../../utils/user.js')
const { ask } = require('../../utils/subscribe.js')
const { ensureContentOk } = require('../../utils/contentCheck.js')

const CART_KEY = 'foodCart'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

Page({
  data: {
    cart: null,
    loading: true,

    // 店铺不配送时（顾客上门、到店自提）整块地点 / 时间都不出现
    needsDelivery: true,

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
        content: '请先回去选商品',
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

      // 不配送的店没有地点和场次可选，直接进到「填微信 + 提交」
      if (r.needs_delivery === false) {
        this.setData({ needsDelivery: false, loading: false }, () => this.recalc())
        return
      }

      const points = r.pickup_points || []
      const batches = r.availableBatches || []
      if (!points.length || !batches.length) {
        this.setData({ loading: false })
        wx.showModal({
          title: '暂时无法下单',
          content: '这家店暂时没有可约的服务时间，请稍后再试。',
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
    // 读缓存，不再多打一次 login（见 utils/user.js）
    myProfile().then(profile => {
      if (profile.wechat && !this.data.contact_wechat) {
        this.setData({ contact_wechat: profile.wechat })
      }
    }).catch(err => console.error('读取微信号失败：', err))
  },

  // 「09-20 周日 18:00 送达（当天 08:00 截单）」
  batchLabel: function (b) {
    let s = this.whenText(b) + ' ' + b.deliver_time + ' 送达'
    if (b.isToday && b.minutesLeft != null) {
      s += b.minutesLeft >= 60
        ? '（还有 ' + Math.floor(b.minutesLeft / 60) + ' 小时截单）'
        : '（还有 ' + b.minutesLeft + ' 分钟截单）'
    } else {
      s += '（当天 ' + b.cutoff + ' 截单）'
    }
    return s
  },

  // 场次是店长指定的某一天，可能在好几天后，「今天/明天」两个词不够用，
  // 得把日期和星期显示出来
  whenText: function (b) {
    if (b.isToday) return '今天'
    if (b.isTomorrow) return '明天'
    const d = new Date(b.date + 'T12:00:00')
    const weekday = isNaN(d.getTime()) ? '' : ' ' + WEEKDAYS[d.getDay()]
    return b.date.slice(5) + weekday
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

    if (d.needsDelivery && d.pointIndex === null) {
      wx.showToast({ title: '请选择服务地点', icon: 'none' })
      return
    }
    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: '请填写你的微信号', icon: 'none' })
      return
    }

    // 正要提交订单，这一刻用户最想知道后续进展，授权成功率最高
    await ask('orderProgress')

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    try {
      // 备注会被店长和配送员看到，属于 UGC
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
        content: '店长会通过微信与你联系确认。\n\n' +
                 (r.needs_delivery === false
                   ? '具体时间和地点请与店长约定。\n\n'
                   : '请在 ' + r.batch_date + ' ' + r.deliver_time + ' 到服务地点自取。\n\n') +
                 '平台只记录下单意向，不参与交易。',
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
