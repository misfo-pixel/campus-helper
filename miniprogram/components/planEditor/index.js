// 配送方案编辑器：服务地点 + 服务时间。
//
// part 决定出哪一半，因为这两半在店铺表单里不再相邻：
// 服务时间要排在「送到买家地址」开关之前（配送队可用与否得按送达时间判断，
// 让店长先选配送方式再填时间，是让他在没有依据的时候做决定），
// 而服务地点只在「买家自取」时才有意义，必须排在那个开关之后。
// 所以同一个页面会放两个实例，各管各的那一半：
//   part="time"   只出服务时间，change 只带 batches
//   part="points" 只出服务地点，change 只带 points
//   part="all"    两半都出（默认，保持老用法不变）
// 各自只抛自己那一半，父页面合并——否则两个实例会互相把对方的数据冲掉。
//
// 店长自送时在店铺设置里用，配送队队长在队伍设置里用——两边填的是同一种东西，
// 所以做成组件，不然这套增删表单要抄两遍。
//
// 场次每次只开一场：买家只关心最近那一趟，多批次对现在这个阶段是过度设计。
// 但抛给父页面的仍然是数组 batches: [ ... ]，数据库结构没变——
// 将来真要恢复「上午班 / 下午班」两趟，放开这里的界面就行，不用迁移任何数据。
//
// 组件自己持有编辑中的状态，每次改动通过 change 事件把自己那一半抛给父页面，
// 父页面提交时直接用最后一次拿到的值。

const { today } = require('../../utils/date.js')

const DEFAULT_BATCH = { date: '', cutoff: '11:00', deliver_time: '12:00' }

Component({
  properties: {
    initPoints: { type: Array, value: [] },
    initBatches: { type: Array, value: [] },
    part: { type: String, value: 'all' },
    // 嵌在宿主页的分组卡里用（小店设置的「线下交付」）：标题和外框由宿主页给，
    // 组件只出内容，免得卡里套卡、标题说两遍
    bare: { type: Boolean, value: false }
  },

  data: {
    points: [],
    batch: Object.assign({}, DEFAULT_BATCH),
    today: '',
    expired: false,
    seeded: false
  },

  lifetimes: {
    attached: function () {
      // 日期选择器的下限，不让选到过去的日子
      this.setData({ today: today() }, () => this.refreshExpired())
    }
  },

  observers: {
    // 父页面读完云端数据才会把值灌进来，只认第一次。
    // 之后组件自己管状态，否则父页面每次 setData 都会把用户正在编辑的内容冲掉。
    'initPoints, initBatches': function (points, batches) {
      if (this.data.seeded) return
      if (!(points || []).length && !(batches || []).length) return

      // 老数据里可能有好几条，只取第一条——其余的在界面上没有位置放
      const first = (batches || [])[0] || {}
      this.setData({
        points: (points || []).map(p => ({
          name: p.name || '',
          fee: p.fee === 0 ? '0' : String(p.fee || '')
        })),
        batch: {
          date: first.date || '',
          cutoff: first.cutoff || DEFAULT_BATCH.cutoff,
          deliver_time: first.deliver_time || DEFAULT_BATCH.deliver_time
        },
        seeded: true
      }, () => this.refreshExpired())
    }
  },

  methods: {
    // 日期落在今天之前 = 这一场已经过去，买家看不到它了
    refreshExpired: function () {
      const d = this.data.batch.date
      this.setData({ expired: !!d && !!this.data.today && d < this.data.today })
    },

    // 只抛自己负责的那一半。两个实例同时存在时，谁都不碰对方的字段——
    // 父页面用 'points' in detail / 'batches' in detail 判断该更新哪个。
    emit: function () {
      const part = this.data.part
      const detail = {}
      if (part !== 'time') detail.points = this.data.points
      if (part !== 'points') detail.batches = [Object.assign({}, this.data.batch)]
      this.triggerEvent('change', detail)
    },

    // ---- 服务地点 ----

    onPointInput: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const field = e.currentTarget.dataset.field
      this.setData({ ['points[' + idx + '].' + field]: e.detail.value }, () => this.emit())
    },

    addPoint: function () {
      this.setData({
        points: this.data.points.concat({ name: '', fee: '' }),
        seeded: true
      }, () => this.emit())
    },

    removePoint: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const points = this.data.points.slice()
      points.splice(idx, 1)
      this.setData({ points: points }, () => this.emit())
    },

    // ---- 服务时间 ----

    onBatchInput: function (e) {
      const field = e.currentTarget.dataset.field
      this.setData({ ['batch.' + field]: e.detail.value, seeded: true }, () => {
        this.refreshExpired()
        this.emit()
      })
    }
  }
})
