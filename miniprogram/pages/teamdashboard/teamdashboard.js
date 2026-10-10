// 配送队工作台。
//
// 2026-09-20 换了形态：原来这里是「按批次 × 店长领活」的派单台，
// 现在只是一个收件箱——店长发来配送请求，队长看到后自己微信联系他。
// 送不送、多少钱、怎么结，平台一概不管。
//
// 同日去掉了「服务中 / 打烊中」开关，换成队长在这儿填的「可配送时段」；
// 2026-10-10 时段也撤了——队长不会天天去填，一过期队伍在店长那边就全灰。
// 现在队伍一直可选，哪一趟能不能送，收到请求后在微信里定，不接就点「不接」。
//
// 原来那套（领活、取货清单、配送费对账）代码还在 teamOrders /
// teammanifest / settlement 里，没接进来。等真有队伍跑起来了，
// 照着他们实际怎么干再决定要不要恢复，比现在猜准。

const { ask, askOrGuide } = require('../../utils/subscribe.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { formatTime } = require('../../utils/date.js')
const { describe } = require('../../utils/delivery.js')

const STATUS_TEXT = { open: '待联系', accepted: '配送中', delivered: '已送达', declined: '没接', no_show: '没来送' }
const END_VERB = { delivered: ' 送达', declined: ' 回绝', no_show: ' 被标没来送' }

// 历史默认只露这么几条，工作台是拿来干活的，不是翻账本的
const HISTORY_FOLDED = 3

function decorateRequest(q) {
  return Object.assign({}, q, describe(q), {
    timeText: formatTime(q.created_at),
    endText: formatTime(q.delivered_at || q.declined_at || q.no_show_at),
    endVerb: END_VERB[q.status] || '',
    // 退单的也落在 declined 里，单独说一句
    statusText: q.released ? '退单' : (STATUS_TEXT[q.status] || q.status)
  })
}

Page({
  data: {
    loading: true,
    loadError: false,      // 读队伍失败：不能显示成「你还不在配送队里」
    requestsError: false,  // 读配送请求失败：不能显示成「还没有店长找你们」
    team: null,
    role: null,
    takedown: false,       // 被下架了：只剩手上的单收尾
    active: [],            // 待联系在前、配送中在后
    openCount: 0,
    acceptedCount: 0,
    history: [],           // 已送达 + 没接，最近 20 条
    historyOpen: false,
    historyFolded: HISTORY_FOLDED,
    busyId: ''             // 正在处理的那一单，只让那一张卡的按钮转圈
  },

  onLoad: function () {
    this.reqSeq = 0
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  retry: function () {
    this.setData({ loading: true, loadError: false, requestsError: false })
    this.load()
  },

  // 读失败和「你还不在配送队里」是两件事，别混成一个空状态：
  // 队长看到「你还不在配送队里 + 创建配送队」按钮，会以为自己的队被删了。
  load: function (done) {
    wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}

      if (!r.success) {
        this.setData({ loading: false, loadError: true })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }

      this.setData({
        team: r.team || null,
        role: r.role || null,
        loading: false,
        loadError: false
      })

      if (r.team) {
        this.loadRequests(done)
      } else if (done) {
        done()
      }
    }).catch(err => {
      console.error('读取队伍失败：', err)
      this.setData({ loading: false, loadError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  // 待办和历史一次拿齐。onShow、下拉、操作完刷新可能叠在一起，
  // 只认最后发出的那一次，晚到的旧回包直接丢掉。
  loadRequests: function (done) {
    const seq = ++this.reqSeq
    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: { action: 'listForTeam' }
    }).then(res => {
      if (done) done()
      if (seq !== this.reqSeq) return
      const r = (res && res.result) || {}

      if (!r.success) {
        this.setData({ requestsError: true })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      const active = (r.active || []).map(decorateRequest)
      const opens = active.filter(q => q.status === 'open')
      const accepted = active.filter(q => q.status !== 'open')
      this.setData({
        requestsError: false,
        takedown: r.takedown === true,
        active: opens.concat(accepted),
        openCount: opens.length,
        acceptedCount: accepted.length,
        history: (r.history || []).map(decorateRequest)
      })
    }).catch(err => {
      if (done) done()
      if (seq !== this.reqSeq) return
      console.error('读取配送请求失败：', err)
      this.setData({ requestsError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  toggleHistory: function () {
    this.setData({ historyOpen: !this.data.historyOpen })
  },

  // 订阅授权必须由点击触发，放在 onShow 里是弹不出来的。
  // 一次授权只能收一条，所以给队长一个随手点的入口，接单时也顺手要一张。
  askReminder: function () {
    askOrGuide('newOrder').then(ok => {
      if (ok) wx.showToast({ title: '下一条新请求会提醒你', icon: 'none' })
    })
  },

  copyWechat: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，去微信添加', icon: 'none' })
    })
  },

  previewPhoto: function (e) {
    const { urls, current } = e.currentTarget.dataset
    if (!urls || !urls.length) return
    wx.previewImage({ urls: urls, current: current })
  },

  // accept / decline / release 共用：发一个动作，成功就整份重拉
  act: function (action, id, okText) {
    if (this.data.busyId) return Promise.resolve()
    this.setData({ busyId: id })
    return wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: { action: action, id: id }
    }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) {
        if (okText) wx.showToast({ title: okText, icon: 'none' })
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
      // 失败多半是别的队员已经处理过了，也重拉一次让界面对上
      this.loadRequests()
    }).catch(err => {
      console.error(action + ' 失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }).then(() => {
      this.setData({ busyId: '' })
    })
  },

  accept: function (e) {
    if (this.data.role === 'admin') ask('newOrder')
    this.act('accept', e.currentTarget.dataset.id, '已接下，送到后记得拍照')
  },

  decline: function (e) {
    const { id, broadcast } = e.currentTarget.dataset
    wx.showModal({
      title: '不接这一单？',
      content: broadcast ? '只从你们的列表里移除，其他队还能接。' : '店长会收到通知，可以换一支队。',
      confirmText: '不接',
      confirmColor: '#C8102E',
      success: res => {
        if (res.confirm) this.act('decline', id, broadcast ? '已移除' : '已告诉店长')
      }
    })
  },

  // 接了去不了：退单。比不吭声强——店长标「没来送」会记爽约
  release: function (e) {
    const { id, broadcast } = e.currentTarget.dataset
    wx.showModal({
      title: '退掉这一单？',
      content: broadcast ? '会放回给其他队接，店长会收到通知。' : '店长会收到通知，可以换一支队。',
      confirmText: '退单',
      confirmColor: '#C8102E',
      success: res => {
        if (res.confirm) this.act('release', id, '已退单')
      }
    })
  },

  // 送到了：拍照留证 + 标记送达。
  //
  // 平台既不派单也不结账，出了「说送了其实没送」的争议，能拿出来的只有照片。
  // 所以这一步是必须传图的，不给「直接标记送达」的口子。
  deliver: async function (e) {
    const id = e.currentTarget.dataset.id
    if (this.data.busyId) return

    let chosen
    try {
      chosen = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 3, mediaType: ['image'], sizeType: ['compressed'],
          success: resolve, fail: reject
        })
      })
    } catch (e2) {
      return   // 用户取消了
    }

    const files = (chosen.tempFiles || []).map(f => f.tempFilePath)
    if (!files.length) return

    this.setData({ busyId: id })
    wx.showLoading({ title: '上传中', mask: true })

    const uploaded = []
    try {
      for (const path of files) {
        const match = path.match(/\.(\w+)$/)
        const ext = match ? match[1] : 'jpg'
        const cloudPath = 'delivery/' + Date.now() + '-' +
          Math.floor(Math.random() * 1000000) + '.' + ext
        const r = await wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: path })
        uploaded.push(r.fileID)
      }

      // 照片只给店长和队长看，不公开，但存进云存储的用户内容一律过一遍机检
      if (!(await ensureContentOk({ fileIDs: uploaded }))) {
        await deleteCloudFiles(uploaded)
        return
      }

      const res = await wx.cloud.callFunction({
        name: 'deliveryRequest',
        data: { action: 'deliver', id: id, photos: uploaded }
      })
      wx.hideLoading()

      const r = (res && res.result) || {}
      if (!r.success) {
        await deleteCloudFiles(uploaded)
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
        this.loadRequests()
        return
      }
      wx.showToast({ title: '已标记送达', icon: 'success' })
      this.loadRequests()
    } catch (err) {
      wx.hideLoading()
      console.error('上传送达照片失败：', err)
      // 传了一半失败，把已经上去的清掉，别在云存储里攒孤儿文件
      if (uploaded.length) await deleteCloudFiles(uploaded)
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },

  goToEdit: function () {
    wx.navigateTo({ url: '/pages/teamedit/teamedit' })
  },

  joinTeam: function () {
    wx.showModal({
      title: '加入配送队',
      editable: true,
      placeholderText: '输入 6 位邀请码',
      success: res => {
        if (!res.confirm || !res.content) return
        wx.showLoading({ title: '加入中', mask: true })
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'join', code: res.content }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已加入' + result.teamName, icon: 'none' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '加入失败', icon: 'none' })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('加入失败：', err)
          wx.showToast({ title: '加入失败', icon: 'none' })
        })
      }
    })
  }
})
