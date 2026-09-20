// 配送队工作台。
// 活按「批次 × 商家」分，一个人领一组，跑一趟：去这家店取这一批，再挨栋楼送完。

Page({
  data: {
    loading: true,
    team: null,
    role: null,
    groups: [],
    me: ''
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load(() => wx.stopPullDownRefresh())
  },

  load: function (done) {
    wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}
      this.setData({ team: r.team || null, role: r.role || null, loading: false })

      // 没队伍、或者队伍还没过审，就没有活可看
      if (r.team && r.team.audit_status === 'approved') {
        this.loadGroups(done)
      } else if (done) {
        done()
      }
    }).catch(err => {
      console.error('读取队伍失败：', err)
      this.setData({ loading: false })
      if (done) done()
    })
  },

  loadGroups: function (done) {
    wx.cloud.callFunction({ name: 'teamOrders', data: { action: 'groups' } }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        if (done) done()
        return
      }
      // 每组标注一下是不是自己领的，模板里好判断按钮显示哪个
      const groups = (r.groups || []).map(g => Object.assign({}, g, {
        shops: g.shops.map(s => Object.assign({}, s, {
          mine: s.deliverer === r.me,
          taken: !!s.deliverer
        }))
      }))
      this.setData({ groups: groups, me: r.me })
      if (done) done()
    }).catch(err => {
      console.error('读取服务时间失败：', err)
      if (done) done()
    })
  },

  claim: function (e) {
    const { batch, shop } = e.currentTarget.dataset
    wx.showLoading({ title: '领取中', mask: true })
    wx.cloud.callFunction({
      name: 'teamOrders',
      data: { action: 'claim', batch_key: batch, shop_id: shop }
    }).then(res => {
      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已领取 ' + r.claimed + ' 单', icon: 'none' })
        this.loadGroups()
      } else {
        wx.showToast({ title: r.message || '领取失败', icon: 'none' })
        this.loadGroups()
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('领取失败：', err)
      wx.showToast({ title: '领取失败', icon: 'none' })
    })
  },

  openManifest: function (e) {
    const { batch, shop } = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/teammanifest/teammanifest?batch=' + encodeURIComponent(batch) + '&shop=' + shop
    })
  },

  goToEdit: function () {
    wx.navigateTo({ url: '/pages/teamedit/teamedit' })
  },
  goToSettlement: function () {
    wx.navigateTo({ url: '/pages/settlement/settlement?as=team' })
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
