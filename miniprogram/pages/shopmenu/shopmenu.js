// 菜单管理。
// 「今天这道菜卖完了」是每天要点好几次的操作，所以上架开关直接放在列表行上，
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
      console.error('读取菜单失败：', err)
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
      console.error('切换菜品状态失败：', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
      this.load()
    })
  },

  deleteItem: function (e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除菜品',
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
          console.error('删除菜品失败：', err)
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
  },

  // 一次性迁移：把老外卖模块 menu_items 里的菜导进来。
  // 按菜名去重，误点两次不会导出两份。
  importLegacy: function () {
    wx.showModal({
      title: '从旧菜单导入',
      content: '会把老外卖模块里的菜品导入当前店铺。同名的菜会自动跳过，不会重复。',
      confirmText: '导入',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '导入中', mask: true })
        wx.cloud.callFunction({
          name: 'shopManage',
          data: { action: 'importLegacyMenu' }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (!result.success) {
            wx.showToast({ title: result.message || '导入失败', icon: 'none' })
            return
          }
          console.log('旧菜单字段：', result.sourceFields)
          wx.showModal({
            title: '导入完成',
            content: '共 ' + result.total + ' 条，导入 ' + result.imported +
                     ' 条，跳过 ' + result.skipped + ' 条（同名或无名称）。\n\n价格和分类请核对一遍再开卖。',
            showCancel: false
          })
          this.load()
        }).catch(err => {
          wx.hideLoading()
          console.error('导入旧菜单失败：', err)
          wx.showToast({ title: '导入失败', icon: 'none' })
        })
      }
    })
  }
})
