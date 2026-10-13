// 确认订单（参团）。
//
// 这一页只把下单意向记下来：不做支付动作，也不展示任何收款方式。
// 成团后买家在确认截止前联系店长，店长确认订单（见 cloudfunctions/groupSettle）。
//
// 场次在店铺页就选好了（随购物车一起存在 storage 里），这里只选取货点。
// 买家到取货点自取，不送到公寓门口。

const { EXACT_ADDRESS_ENABLED } = require('../../config.js')
const { md, weekday, cutoffText } = require('../../utils/group.js')
const { ask } = require('../../utils/subscribe.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { readCachedProfile, checkEmailVerified } = require('../../utils/user.js')

const CART_KEY = 'shopCart'

// 上一单填的手机号 / 楼栋 / 房间号，下次直接带上。只存本机，不进云端
const LAST_DELIVERY_KEY = 'lastDelivery'

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

Page({
  data: {
    cart: null,
    loading: true,

    session: null,     // 这一场，带 whenText / cutText / ruleText 显示用

    // 送到我填的地址（true），还是我去固定点位自取（false）
    exactAddress: false,
    buildingId: '',
    buildingName: '',
    unit: '',
    phone: '',
    flatFee: 0,

    points: [],
    pointLabels: [],
    pointIndex: null,

    email: '',   // 资料页验证过的邮箱，下单就用它，不再手填
    note: '',
    // 补充说明和配图每家店都有；店长开了「下单时要买家补充说明」只是变成必填。
    // noteHint 是他自己写的提示语，没写就用一句通用的。
    // noteImages 存的是本地临时路径，提交时才真的上传。
    noteRequired: false,
    noteHint: '',
    noteImages: [],

    deliveryFee: 0,
    total: 0,
    submitting: false
  },

  // 从资料页验证完邮箱返回时刷新
  onShow: function () {
    const profile = readCachedProfile() || {}
    this.setData({ email: profile.emailVerified ? (profile.email || '已验证') : '' })
  },

  goVerifyEmail: function () {
    wx.navigateTo({ url: '/pages/editprofile/editprofile?verify=1' })
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

    try {
      const last = wx.getStorageSync(LAST_DELIVERY_KEY)
      if (last) {
        this.setData({
          phone: last.phone || '',
          buildingId: last.buildingId || '',
          buildingName: last.buildingName || '',
          unit: last.unit || ''
        })
      }
    } catch (e) {
      // 读不到就从空的开始填
    }

    wx.cloud.callFunction({
      name: 'shopBrowse',
      data: { action: 'plan', shopId: cart.shopId, sessionId: cart.sessionId }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      const s = r.session
      // 页面开太久，这一场已经截单了；或者送上门暂时关着（见 config.js）
      if (!s || (r.exact_address === true && !EXACT_ADDRESS_ENABLED) || (!r.exact_address && !s.points.length)) {
        this.setData({ loading: false })
        wx.showModal({
          title: '这一场已截单',
          content: '回店铺看看其他场次',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }

      const min = Number(s.min_orders) || 0
      this.setData({
        noteRequired: r.note_required === true,
        noteHint: r.note_hint || '',
        session: Object.assign({}, s, {
          whenText: md(s.date) + ' ' + weekday(s.date) + ' ' + s.depart_time + ' 出发',
          cutText: cutoffText(s, ''),
          ruleText: min ? '满 ' + min + ' 单成团，成团后联系店长确认' : '截单后联系店长确认'
        }),
        exactAddress: r.exact_address === true,
        flatFee: Number(r.flat_delivery_fee) || 0,
        points: s.points,
        pointLabels: s.points.map(p => p.name + ' · 约 ' + p.arrive + ' 到' + (p.fee > 0 ? ' · $' + p.fee : '')),
        // 只有一个点就替买家选上
        pointIndex: s.points.length === 1 ? 0 : null,
        loading: false
      }, () => this.recalc())
    }).catch(err => {
      console.error('读取场次失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  pickBuilding: function () {
    wx.navigateTo({
      url: '/pages/buildingpick/buildingpick?id=' + this.data.buildingId,
      events: {
        picked: b => this.setData({ buildingId: b._id, buildingName: b.name })
      }
    })
  },

  onPointChange: function (e) {
    this.setData({ pointIndex: Number(e.detail.value) }, () => this.recalc())
  },

  recalc: function () {
    const d = this.data
    // 送上门是一口价；自取按选中的那个点位收
    const fee = d.exactAddress
      ? (Number(d.flatFee) || 0)
      : (d.pointIndex === null ? 0 : (Number(d.points[d.pointIndex].fee) || 0))
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

    // 按页面上从上到下的顺序查，提示的总是最先看到的那个空项
    if (!checkEmailVerified()) return
    const digits = d.phone.replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 15) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    if (d.exactAddress && !d.buildingId) {
      wx.showToast({ title: '请选择楼栋', icon: 'none' })
      return
    }
    if (d.exactAddress && !d.unit.trim()) {
      wx.showToast({ title: '请填写房间号', icon: 'none' })
      return
    }
    if (!d.exactAddress && d.pointIndex === null) {
      wx.showToast({ title: '请选择取货点', icon: 'none' })
      return
    }
    if (d.noteRequired && !d.note.trim()) {
      wx.showToast({ title: '请填写补充说明', icon: 'none' })
      return
    }

    // 正要提交订单，这一刻用户最想知道后续进展，授权成功率最高。
    // 有门槛的团多要一张拼团进度的票：截单前 2 小时还没成团时提醒他去拉人。
    // 一次弹窗里勾两项，各换一张票（一次最多 3 个模板）
    await ask(d.session.min_orders ? ['orderProgress', 'groupProgress'] : 'orderProgress')

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    try {
      // 备注会被店长和配送员看到，属于 UGC
      if (!(await ensureContentOk({
        texts: [d.note, d.unit, d.buildingId === 'other' ? d.buildingName : ''],
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

      const res = await wx.cloud.callFunction({
        name: 'buyerOrders',
        data: {
          action: 'create',
          shopId: d.cart.shopId,
          items: d.cart.items.map(i => ({ item_id: i.item_id, count: i.count })),
          pickup_point: d.exactAddress ? '' : d.points[d.pointIndex].name,
          building_id: d.exactAddress ? d.buildingId : '',
          other_address: d.buildingId === 'other' ? d.buildingName : '',
          unit: d.unit,
          phone: d.phone,
          session_id: d.session._id,
          source: d.cart.source || '',
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
      try {
        wx.setStorageSync(LAST_DELIVERY_KEY, {
          phone: d.phone,
          buildingId: d.buildingId,
          buildingName: d.buildingName,
          unit: d.unit
        })
      } catch (e) {
        // 存不上下次再填一遍，不影响这一单
      }

      // 参团成功页：显示进度、喊人上车。参数都是刚下完单那一刻的
      const q = {
        shop: d.cart.shopId,
        name: d.cart.shopName,
        s: r.session_id,
        count: r.count,
        min: r.min_orders,
        cut: r.cutoff_at,
        date: r.date,
        at: r.deliver_time,
        point: r.pickup_point
      }
      wx.redirectTo({
        url: '/pages/groupjoined/groupjoined?' + Object.keys(q)
          .map(k => k + '=' + encodeURIComponent(q[k] === undefined ? '' : q[k])).join('&')
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
