// 配送方案编辑器：服务地点 + 服务时间。
//
// 商家自送时在店铺设置里用，配送队队长在队伍设置里用——两边填的是同一种东西，
// 所以做成组件，不然这套增删表单要抄两遍。
//
// 场次每次只开一场：买家只关心最近那一趟，多批次对现在这个阶段是过度设计。
// 但抛给父页面的仍然是数组 batches: [ ... ]，数据库结构没变——
// 将来真要恢复「上午班 / 下午班」两趟，放开这里的界面就行，不用迁移任何数据。
//
// 组件自己持有编辑中的状态，每次改动通过 change 事件把完整的 { points, batches }
// 抛给父页面，父页面提交时直接用最后一次拿到的值。

const DEFAULT_BATCH = { date: '', cutoff: '11:00', deliver_time: '12:00' }

function todayStr() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

Component({
  properties: {
    initPoints: { type: Array, value: [] },
    initBatches: { type: Array, value: [] }
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
      this.setData({ today: todayStr() }, () => this.refreshExpired())
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

    emit: function () {
      this.triggerEvent('change', {
        points: this.data.points,
        batches: [Object.assign({}, this.data.batch)]
      })
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
