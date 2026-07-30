Page({
  data: {
    items: [],        // 显示的商品(可能是过滤后的)
    allItems: [],     // 全部在售商品(用于搜索过滤)
    keyword: ''       // 搜索关键词
  },

  onShow: function () {
    const db = wx.cloud.database()
    db.collection('secondhand_items')
      .where({ status: 'on_sale' })
      .orderBy('created_at', 'desc')
      .get()
      .then(res => {
        this.setData({
          allItems: res.data,
          items: res.data   // 初始显示全部
        })
      })
      .catch(err => console.error('加载失败：', err))
  },

  // 搜索输入
  onSearchInput: function (e) {
    const keyword = e.detail.value.trim()
    this.setData({ keyword: keyword })
    if (!keyword) {
      // 空搜索词，显示全部
      this.setData({ items: this.data.allItems })
    } else {
      // 过滤：标题含关键词的
      const filtered = this.data.allItems.filter(item =>
        item.title.toLowerCase().includes(keyword.toLowerCase())
      )
      this.setData({ items: filtered })
    }
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/itemdetail/itemdetail?id=' + id })
  },
})