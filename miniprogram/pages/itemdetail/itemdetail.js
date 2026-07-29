Page({
  data: {
    item: null,
    isOwner: false
  },
  deleteItem: function () {
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定吗？',
      success: (res) => {
        if (res.confirm) {
          wx.cloud.callFunction({
            name: 'deleteItem',
            data: { itemId: this.data.item._id }   // 传要删的商品id
          }).then(res => {
            if (res.result.success) {
              wx.showToast({ title: '已删除', icon: 'success' })
              setTimeout(() => wx.navigateBack(), 1000)
            } else {
              wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
            }
          }).catch(err => {
            console.error('删除失败：', err)
            wx.showToast({ title: '删除失败', icon: 'none' })
          })
        }
      }
    })
  },

  markSold: function () {
    wx.showModal({
      title: '确认已售',
      content: '标记后商品将从市场下架，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('secondhand_items').doc(this.data.item._id).update({
            data: { status: 'sold' }
          }).then(() => {
            wx.showToast({ title: '已标记售出', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('标记失败：', err)
            wx.showToast({ title: '操作失败', icon: 'none' })
          })
        }
      }
    })
  },

  onLoad: function (options) {
    const id = options.id
    const db = wx.cloud.database()
  
    db.collection('secondhand_items').doc(id).get().then(res => {
      const item = res.data
      this.setData({ item: item })
  
    // 自己调 login 拿当前用户身份，可靠判断能不能删
    wx.cloud.callFunction({ name: 'login' }).then(loginRes => {
      if (loginRes.result.success) {
        const myOpenid = loginRes.result.openid
        const roles = loginRes.result.roles || []              // 改：拿 roles 数组
        const isOwner = (myOpenid === item._openid)
        const isMarketAdmin = roles.includes('market_admin') || roles.includes('super_admin')  // 改：查数组
        this.setData({ 
          canDelete: isOwner || isMarketAdmin,  // 改：用新变量
          isOwner: isOwner            // 新增:标记已售只有本人能做
        })
      }
    })
    }).catch(err => {
      console.error('加载详情失败：', err)
    })
  },

  // 一键复制卖家微信
  copyWechat: function () {
    wx.setClipboardData({
      data: this.data.item.seller_wechat,
      success: () => {
        wx.showToast({ title: '微信号已复制', icon: 'success' })
      }
    })
  }
})