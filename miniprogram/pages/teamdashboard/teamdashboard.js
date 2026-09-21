// 配送队工作台。
//
// 2026-09-20 换了形态：原来这里是「按批次 × 店长领活」的派单台，
// 现在只是一个收件箱——店长发来配送请求，队长看到后自己微信联系他。
// 送不送、多少钱、怎么结，平台一概不管。
//
// 同日去掉了「服务中 / 打烊中」开关：队长在这儿填可配送时段，填了哪几段
// 就是那几段接活，一段不填等于以前的打烊。一个状态少一个要人记得去关的地方，
// 而且店长那边本来就要按送达时间挑队伍——光有一个「服务中」也答不了
// 「你们周六晚上七点能不能送」。
//
// 原来那套（领活、取货清单、配送费对账）代码还在 teamOrders /
// teammanifest / settlement 里，没接进来。等真有队伍跑起来了，
// 照着他们实际怎么干再决定要不要恢复，比现在猜准。

const { ask } = require('../../utils/subscribe.js')
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

const STATUS_TEXT = { open: '待联系', accepted: '配送中', delivered: '已送达' }
const { formatTime, today, dateText, slotText } = require('../../utils/date.js')

// 可配送时段的默认值：傍晚两小时。学生队伍下了课才出车，先给一个大概率对的，
// 队长只改不对的那一格，比三格都从头选快。
const DEFAULT_SLOT = { start: '18:00', end: '20:00' }
const MAX_SLOTS = 8   // 和云函数 cleanAvailability 里的上限是同一个数，改要一起改

// 时段在界面上要显示成「9-19 周六」和整句两种形态，存的时候只存三个字段，
// 所以每次改完都在这里补一遍展示文案。
function decorateSlots(list) {
  return (list || []).map(s => ({
    date: s.date,
    start: s.start,
    end: s.end,
    dateText: dateText(s.date),
    text: slotText(s)
  }))
}

Page({
  data: {
    loading: true,
    loadError: false,      // 读队伍失败：不能显示成「你还不在配送队里」
    requestsError: false,  // 读配送请求失败：不能显示成「还没有店长找你们」
    team: null,
    role: null,
    tab: 'open',        // open 进行中（未送达）/ done 已送达
    uploading: false,
    requests: [],
    slots: [],          // 可配送时段 [{ date, start, end, dateText, text }]
    today: ''           // 日期选择器的下限，不让队长填到过去的日子
  },

  onLoad: function () {
    this.setData({ today: today() })
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  switchTab: function (e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab: tab, requests: [] }, () => this.loadRequests())
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
        // 云函数已经把过期的时段滤掉了，这里拿到的就是还没过的
        slots: decorateSlots(r.team && r.team.availability),
        loading: false,
        loadError: false
      })

      if (r.team) {
        // 队长得自己授权才收得到「有人委托你配送」的提醒。
        // 一次授权一条，所以每次打开工作台都补一次。
        if (r.role === 'admin') ask('newOrder')
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

  loadRequests: function (done) {
    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: { action: 'listForTeam', done: this.data.tab === 'done' }
    }).then(res => {
      const r = (res && res.result) || {}

      if (!r.success) {
        this.setData({ requestsError: true })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }

      this.setData({
        requestsError: false,
        requests: (r.requests || []).map(q => Object.assign({}, q, {
          statusText: STATUS_TEXT[q.status] || q.status,
          timeText: formatTime(q.created_at)
        }))
      })
      if (done) done()
    }).catch(err => {
      console.error('读取配送请求失败：', err)
      this.setData({ requestsError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  },

  // ---- 可配送时段 ----
  //
  // 队长填「哪天几点能出车」，这是店长那边唯一的判断依据：店长在小店设置里
  // 填了送达时间，按送达前后各半小时算一个窗口（取货、过去、交接都要时间），
  // 整段盖得住的队伍才选得中，盖不住的置灰。判断在 utils/shopForm.js 的
  // markTeams 里。所以这里一条都不填 = 谁也选不到你们，等于以前的打烊。
  //
  // 约到哪一趟仍然是他们俩在微信里敲定的，平台只管「能不能选」这一层。
  //
  // 改一下存一次：这里没有「保存」按钮。三个选择器 + 增删本来就是零碎操作，
  // 攒着等提交，队长改完直接退出页面就全丢了。

  addSlot: function () {
    if (this.data.role !== 'admin') return
    if (this.data.slots.length >= MAX_SLOTS) {
      wx.showToast({ title: '最多填 ' + MAX_SLOTS + ' 个时段', icon: 'none' })
      return
    }
    this.saveSlots(this.data.slots.concat({
      date: this.data.today,
      start: DEFAULT_SLOT.start,
      end: DEFAULT_SLOT.end
    }))
  },

  onSlotChange: function (e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    if (!this.data.slots[index]) return

    const next = this.data.slots.map((s, i) => (
      i === index ? Object.assign({}, s, { [field]: e.detail.value }) : s
    ))

    // 结束时间不晚于开始时间的话，这一行读不出任何意思，店长也没法照着约。
    // 不替队长猜他想改哪一头（改早了开始？还是想跨夜？），直接把这一下退回去。
    if (next[index].end <= next[index].start) {
      wx.showToast({ title: '结束时间要晚于开始时间', icon: 'none' })
      return
    }
    this.saveSlots(next)
  },

  removeSlot: function (e) {
    const index = Number(e.currentTarget.dataset.index)
    this.saveSlots(this.data.slots.filter((s, i) => i !== index))
  },

  // 整份列表覆盖写。失败就把整份翻回改之前的样子——
  // 半份新半份旧的话，队长看到的和店长看到的对不上，还查不出是哪一行没存上。
  saveSlots: function (next) {
    const before = this.data.slots
    this.setData({ slots: decorateSlots(next) })

    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: {
        action: 'setAvailability',
        // 只把三个字段发上去，dateText / text 是界面用的，别存进库
        availability: next.map(s => ({ date: s.date, start: s.start, end: s.end }))
      }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ slots: before })
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
      }
    }).catch(err => {
      console.error('保存可配送时段失败：', err)
      this.setData({ slots: before })
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },

  copyWechat: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，去微信加他', icon: 'none' })
    })
  },

  accept: function (e) {
    const id = e.currentTarget.dataset.id
    wx.cloud.callFunction({
      name: 'deliveryRequest',
      data: { action: 'accept', id: id }
    }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) {
        this.loadRequests()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    }).catch(err => {
      console.error('接单失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    })
  },

  // 送到了：拍照留证 + 标记送达。
  //
  // 平台既不派单也不结账，出了「说送了其实没送」的争议，能拿出来的只有照片。
  // 所以这一步是必须传图的，不给「直接标记送达」的口子。
  deliver: async function (e) {
    const id = e.currentTarget.dataset.id
    if (this.data.uploading) return

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

    this.setData({ uploading: true })
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
      this.setData({ uploading: false })
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
