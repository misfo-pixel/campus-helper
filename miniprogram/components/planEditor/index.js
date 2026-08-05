// 配送方案编辑器：取餐点 + 批次时间。
//
// 商家自送时在店铺设置里用，配送队队长在队伍设置里用——两边填的是同一种东西，
// 所以做成组件，不然这套增删表单要抄两遍。
//
// 组件自己持有编辑中的状态，每次改动通过 change 事件把完整的 { points, batches }
// 抛给父页面，父页面提交时直接用最后一次拿到的值。

Component({
  properties: {
    initPoints: { type: Array, value: [] },
    initBatches: { type: Array, value: [] }
  },

  data: {
    points: [],
    batches: [],
    seeded: false
  },

  observers: {
    // 父页面读完云端数据才会把值灌进来，只认第一次。
    // 之后组件自己管状态，否则父页面每次 setData 都会把用户正在编辑的内容冲掉。
    'initPoints, initBatches': function (points, batches) {
      if (this.data.seeded) return
      if (!(points || []).length && !(batches || []).length) return
      this.setData({
        points: (points || []).map(p => ({
          name: p.name || '',
          address: p.address || '',
          fee: p.fee === 0 ? '0' : String(p.fee || '')
        })),
        batches: (batches || []).map(b => Object.assign({}, b)),
        seeded: true
      })
    }
  },

  methods: {
    emit: function () {
      this.triggerEvent('change', {
        points: this.data.points,
        batches: this.data.batches
      })
    },

    // ---- 取餐点 ----

    onPointInput: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const field = e.currentTarget.dataset.field
      this.setData({ ['points[' + idx + '].' + field]: e.detail.value }, () => this.emit())
    },

    addPoint: function () {
      this.setData({
        points: this.data.points.concat({ name: '', address: '', fee: '' }),
        seeded: true
      }, () => this.emit())
    },

    removePoint: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const points = this.data.points.slice()
      points.splice(idx, 1)
      this.setData({ points: points }, () => this.emit())
    },

    // ---- 批次 ----

    onBatchInput: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const field = e.currentTarget.dataset.field
      this.setData({ ['batches[' + idx + '].' + field]: e.detail.value }, () => this.emit())
    },

    addBatch: function () {
      this.setData({
        batches: this.data.batches.concat({ label: '', cutoff: '11:00', deliver_time: '12:00' }),
        seeded: true
      }, () => this.emit())
    },

    removeBatch: function (e) {
      const idx = Number(e.currentTarget.dataset.index)
      const batches = this.data.batches.slice()
      batches.splice(idx, 1)
      this.setData({ batches: batches }, () => this.emit())
    }
  }
})
