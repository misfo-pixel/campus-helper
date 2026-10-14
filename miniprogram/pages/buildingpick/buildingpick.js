// 下单时选楼。送上门只送名单里的楼（明大 Minneapolis 校区 + 周边约 1 mile
// 的公寓），名单在 buildings 云函数和 delivery_buildings 集合里。
//
// 从确认订单页 navigateTo 过来，选完用 eventChannel 把 { _id, name } 传回去。
// 名单里找不到的楼可以选「其他」手填：这一单店长会看到「名单外地址」，
// 自己判断送不送得到；下单时云函数顺手写一条意见反馈，管理员核实后加进名单。
// 传回去的 _id 是 'other'，name 是买家填的地址。
const { t } = require('../../i18n/index.js')

const KIND_TEXT = { campus: t('教学楼'), dorm: t('宿舍'), apartment: t('公寓') }

Page({
  data: {
    loading: true,
    loadError: false,
    keyword: '',
    groups: [],        // [{ area, items: [{ _id, name, kindText }] }]，已按关键词过滤
    selectedId: ''
  },

  onLoad: function (options) {
    this.all = []
    this.areas = []
    this.setData({ selectedId: options.id || '' })
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({ name: 'buildings', data: { action: 'list' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false, loadError: true })
        wx.showToast({ title: t(r.message || t('读取失败')), icon: 'none' })
        return
      }
      this.areas = r.areas || []
      this.all = (r.buildings || []).map(b => Object.assign({}, b, {
        kindText: KIND_TEXT[b.kind] || '',
        search: b.name.toLowerCase()
      }))
      this.setData({ loading: false, loadError: false }, () => this.filter())
    }).catch(err => {
      console.error('读取楼栋失败：', err)
      this.setData({ loading: false, loadError: true })
      wx.showToast({ title: t('读取失败'), icon: 'none' })
    })
  },

  retry: function () {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  onSearch: function (e) {
    this.setData({ keyword: e.detail.value }, () => this.filter())
  },

  // 按片区分组，片区顺序跟云函数给的走，组内按录入顺序
  filter: function () {
    const kw = this.data.keyword.trim().toLowerCase()
    const hit = this.all.filter(b => !kw || b.search.indexOf(kw) >= 0)
    const groups = this.areas.map(area => ({
      area: area,
      items: hit.filter(b => b.area === area).sort((a, b) => a.order - b.order)
    })).filter(g => g.items.length)
    this.setData({ groups: groups })
  },

  pick: function (e) {
    const { id, name } = e.currentTarget.dataset
    const channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
    if (channel && channel.emit) channel.emit('picked', { _id: id, name: name })
    wx.navigateBack()
  },

  pickOther: function () {
    wx.showModal({
      title: t('输入你的地址'),
      editable: true,
      placeholderText: t('公寓名或街道门牌，如 1234 SE 5th St'),
      success: res => {
        const text = String(res.content || '').trim()
        if (!res.confirm) return
        if (text.length < 4) {
          wx.showToast({ title: t('地址写完整一点'), icon: 'none' })
          return
        }
        const channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
        if (channel && channel.emit) channel.emit('picked', { _id: 'other', name: text.slice(0, 100) })
        wx.navigateBack()
      }
    })
  }
})
