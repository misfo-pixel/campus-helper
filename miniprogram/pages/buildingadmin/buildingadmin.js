// 配送楼栋名单（超管 / 运营管理员）。买家选「送到买家地址」时只能挑这里启用的楼。
//
// 只增、改名、启用停用，不删：停用就够了，误删了还得重新录。
// 权限在 buildings 云函数里服务端校验，前端这层只是入口。

const KINDS = [
  { key: 'apartment', text: '公寓' },
  { key: 'dorm', text: '宿舍' },
  { key: 'campus', text: '教学楼' }
]
const KIND_TEXT = { campus: '教学楼', dorm: '宿舍', apartment: '公寓' }

Page({
  data: {
    loading: true,
    loadError: false,
    areas: [],
    groups: [],         // [{ area, items }]，含停用的
    activeCount: 0,
    total: 0,

    kinds: KINDS,
    newName: '',
    newArea: 0,
    newKind: 0,
    adding: false
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'buildings', data: { action: 'adminList' } }).then(res => {
      if (done) done()
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false, loadError: true })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      const areas = r.areas || []
      const list = (r.buildings || []).map(b => Object.assign({}, b, { kindText: KIND_TEXT[b.kind] || '' }))
      this.setData({
        loading: false,
        loadError: false,
        areas: areas,
        total: list.length,
        activeCount: list.filter(b => b.active).length,
        groups: areas.map(area => ({
          area: area,
          items: list.filter(b => b.area === area).sort((a, b) => (a.order || 0) - (b.order || 0))
        })).filter(g => g.items.length)
      })
    }).catch(err => {
      if (done) done()
      console.error('读取楼栋失败：', err)
      this.setData({ loading: false, loadError: true })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  retry: function () {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  call: function (data, okText) {
    return wx.cloud.callFunction({ name: 'buildings', data: data }).then(res => {
      const r = (res && res.result) || {}
      wx.showToast({ title: r.success ? okText : (r.message || '操作失败'), icon: 'none' })
      if (r.success) this.load()
      return r.success
    }).catch(err => {
      console.error('楼栋操作失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
      return false
    })
  },

  seed: function () {
    wx.showModal({
      title: '导入初始名单',
      content: '导入一版明大 Minneapolis 校区和周边公寓的名单。不确定的几栋默认停用，核实后再打开。',
      success: res => {
        if (res.confirm) this.call({ action: 'seed' }, '已导入')
      }
    })
  },

  toggle: function (e) {
    const { id } = e.currentTarget.dataset
    this.call({ action: 'update', id: id, active: e.detail.value }, e.detail.value ? '已启用' : '已停用')
  },

  rename: function (e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '改名',
      editable: true,
      content: name,
      success: res => {
        if (res.confirm && res.content && res.content.trim() !== name) {
          this.call({ action: 'update', id: id, name: res.content }, '已改名')
        }
      }
    })
  },

  onNewName: function (e) {
    this.setData({ newName: e.detail.value })
  },

  onNewArea: function (e) {
    this.setData({ newArea: Number(e.detail.value) })
  },

  onNewKind: function (e) {
    this.setData({ newKind: Number(e.currentTarget.dataset.index) })
  },

  add: function () {
    const d = this.data
    if (d.adding) return
    if (!d.newName.trim()) {
      wx.showToast({ title: '请填写楼名', icon: 'none' })
      return
    }
    this.setData({ adding: true })
    this.call({
      action: 'add',
      name: d.newName,
      area: d.areas[d.newArea],
      kind: KINDS[d.newKind].key
    }, '已添加').then(ok => {
      this.setData({ adding: false })
      if (ok) this.setData({ newName: '' })
    })
  }
})
