// 商品管理。
// 「今天这件卖完了」是每天要点好几次的操作，所以上架开关直接放在列表行上，
// 不要求商家点进编辑页再保存。

Page({
  data: {
    loading: true,
    groups: []   // [{ category, items: [...] }]
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'listItems' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      this.setData({ groups: this.groupByCategory(r.items || []), loading: false })
    }).catch(err => {
      console.error('读取商品失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 按分类分组，没填分类的归到「未分类」并排在最后
  groupByCategory: function (items) {
    const map = {}
    const order = []
    items.forEach(item => {
      const cat = item.category || '未分类'
      if (!map[cat]) {
        map[cat] = []
        order.push(cat)
      }
      map[cat].push(item)
    })
    order.sort((a, b) => {
      if (a === '未分类') return 1
      if (b === '未分类') return -1
      return 0
    })
    return order.map(cat => ({ category: cat, items: map[cat] }))
  },

  // 上架 / 售罄
  toggleItem: function (e) {
    const id = e.currentTarget.dataset.id
    const available = e.detail.value

    wx.cloud.callFunction({
      name: 'shopManage',
      data: { action: 'toggleItem', itemId: id, available: available }
    }).then(res => {
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: available ? '已上架' : '已标记售罄', icon: 'none' })
        this.load()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
        this.load()   // 切换失败就刷回真实状态，别让开关停在假状态上
      }
    }).catch(err => {
      console.error('切换商品状态失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
      this.load()
    })
  },

  deleteItem: function (e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除商品',
      content: '确定删除「' + name + '」吗？删除后无法恢复。',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'shopManage',
          data: { action: 'deleteItem', itemId: id }
        }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '删除失败', icon: 'none' })
          }
        }).catch(err => {
          console.error('删除商品失败：', err)
          wx.showToast({ title: '删除失败', icon: 'none' })
        })
      }
    })
  },

  editItem: function (e) {
    wx.navigateTo({ url: '/pages/shopitem/shopitem?id=' + e.currentTarget.dataset.id })
  },

  addItem: function () {
    wx.navigateTo({ url: '/pages/shopitem/shopitem' })
  }
})
