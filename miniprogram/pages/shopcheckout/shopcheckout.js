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
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

const CART_KEY = 'shopCart'

// 买家补充说明的配图。单独放一个目录，和店铺 Logo、商品图分开，
// 将来要按订单清理时一眼能圈出范围。
const NOTE_IMAGE_MAX = 3

function uploadNoteImage(tempPath) {
  const match = tempPath.match(/\.(\w+)$/)
  const ext = match ? match[1] : 'jpg'
  const cloudPath = 'order_notes/' + Date.now() + '-' +
    Math.floor(Math.random() * 1000000) + '.' + ext
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath })
    .then(r => r.fileID)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

Page({
  data: {
    cart: null,
    loading: true,

    // 纯线上服务：整块地点 / 时间都不出现
    needsDelivery: true,
    // 送到我填的地址（true），还是我去固定点位自取（false）
    exactAddress: false,
    address: '',
    flatFee: 0,

    points: [],
    pointLabels: [],
    pointIndex: null,

    batches: [],
    batchLabels: [],
    batchIndex: 0,

    contact_wechat: '',
    note: '',
    // 店长开了「下单时要买家补充说明」才出现。noteHint 是他自己写的提示语，
    // 没写就用一句通用的。noteImages 存的是本地临时路径，提交时才真的上传。
    noteRequired: false,
    noteHint: '',
    noteImages: [],

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

      // 这两项和配送方式无关，三种分支都要，所以先设
      this.setData({
        noteRequired: r.note_required === true,
        noteHint: r.note_hint || ''
      })

      // 纯线上服务没有地点和场次可选，直接进到「填微信 + 提交」
      if (r.needs_delivery === false) {
        this.setData({ needsDelivery: false, loading: false }, () => this.recalc())
        return
      }

      const batches = r.availableBatches || []

      // 送到我填的地址：没有点位可选，配送费是店长定的一口价
      if (r.exact_address === true) {
        if (!batches.length) {
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
          exactAddress: true,
          flatFee: Number(r.flat_delivery_fee) || 0,
          batches: batches,
          batchLabels: batches.map(b => this.batchLabel(b)),
          batchIndex: 0,
          loading: false
        }, () => this.recalc())
        return
      }

      const points = r.pickup_points || []
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
    const d = this.data
    let fee = 0
    if (d.needsDelivery) {
      // 送上门是一口价；自取按选中的那个点位收
      fee = d.exactAddress
        ? (Number(d.flatFee) || 0)
        : (d.pointIndex === null ? 0 : (Number(d.points[d.pointIndex].fee) || 0))
    }
    const total = Math.round((d.cart.subtotal + fee) * 100) / 100
    this.setData({ deliveryFee: fee, total: total })
  },

  chooseNoteImages: function () {
    const left = NOTE_IMAGE_MAX - this.data.noteImages.length
    if (left <= 0) return
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const paths = res.tempFiles.map(f => f.tempFilePath)
        this.setData({ noteImages: this.data.noteImages.concat(paths) })
      }
    })
  },

  removeNoteImage: function (e) {
    const list = this.data.noteImages.slice()
    list.splice(Number(e.currentTarget.dataset.index), 1)
    this.setData({ noteImages: list })
  },

  previewNoteImage: function (e) {
    const url = e.currentTarget.dataset.url
    wx.previewImage({ urls: this.data.noteImages, current: url })
  },

  submit: async function () {
    const d = this.data
    if (d.submitting) return

    if (d.needsDelivery && d.exactAddress && !d.address.trim()) {
      wx.showToast({ title: '请填写收货地址', icon: 'none' })
      return
    }
    if (d.needsDelivery && !d.exactAddress && d.pointIndex === null) {
      wx.showToast({ title: '请选择取货地点', icon: 'none' })
      return
    }
    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: '请填写你的微信号', icon: 'none' })
      return
    }
    if (d.noteRequired && !d.note.trim()) {
      wx.showToast({ title: '请填写补充说明', icon: 'none' })
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

      // 图片等文字过了再传：文字没过就不用白传一趟。
      // 传完单独过一次检，没过就把刚传上去的删掉，不留孤儿文件。
      let noteImages = []
      if (d.noteImages.length) {
        noteImages = await Promise.all(d.noteImages.map(uploadNoteImage))
        if (!(await ensureContentOk({ fileIDs: noteImages }))) {
          await deleteCloudFiles(noteImages)
          return
        }
      }

      const batch = d.batches[d.batchIndex]
      const res = await wx.cloud.callFunction({
        name: 'buyerOrders',
        data: {
          action: 'create',
          shopId: d.cart.shopId,
          items: d.cart.items.map(i => ({ item_id: i.item_id, count: i.count })),
          pickup_point: d.exactAddress ? '' : d.points[d.pointIndex].name,
          address: d.address,
          batch_key: batch.key,
          contact_wechat: d.contact_wechat,
          note: d.note,
          note_images: noteImages
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
                   ? '这是线上服务，没有取货环节。\n\n'
                   : (d.exactAddress
                       ? '预计 ' + r.batch_date + ' ' + r.deliver_time + ' 送到你填的地址。\n\n'
                       : '请在 ' + r.batch_date + ' ' + r.deliver_time + ' 到取货地点自取。\n\n')) +
                 '平台只记录下单意向，不参与交易。',
        showCancel: false,
        confirmText: '知道了',
        success: () => {
          wx.redirectTo({ url: '/pages/myshoporders/myshoporders' })
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
