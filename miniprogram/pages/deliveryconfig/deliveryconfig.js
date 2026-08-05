// 配送数据（超管 / 饭搭子管理员）。
//
// 定价已经不归平台了——取餐点和批次由实际送货的一方定：
// 商家自送在店铺设置里填，配送队在队伍设置里填。
//
// 这里只剩下看数据。留着是因为调价需要依据，而单量数据只有平台这一层看得全：
// 哪个批次没人下单、哪个取餐点一周才两单，商家和队伍各自只看得到自己那部分。

Page({
  data: {
    loading: true,
    stats: null,
    days: 30
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  switchDays: function (e) {
    const days = Number(e.currentTarget.dataset.days)
    if (days === this.data.days) return
    this.setData({ days: days, loading: true }, () => this.load())
  },

  load: function (done) {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'stats', days: this.data.days }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        if (done) done()
        return
      }
      this.setData({ stats: r, loading: false })
      if (done) done()
    }).catch(err => {
      console.error('读取单量统计失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
      if (done) done()
    })
  }
})
