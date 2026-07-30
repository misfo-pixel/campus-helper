Page({
  data: {
    item: null,
    canDelete: false,
    isOwner: false
  },

  onLoad: function (options) {
    const id = options.id
    const db = wx.cloud.database()

    db.collection('sublet_items').doc(id).get().then(res => {
      const item = res.data
      this.setData({ item: item })

      // 判断权限：本人 或 转租管理员
      wx.cloud.callFunction({ name: 'login' }).then(loginRes => {
        if (loginRes.result.success) {
          const myOpenid = loginRes.result.openid
          const roles = loginRes.result.roles || []
          const isOwner = (myOpenid === item._openid)
          const isSubletAdmin = roles.includes('sublet_admin') || roles.includes('super_admin')
          this.setData({
            canDelete: isOwner || isSubletAdmin,
            isOwner: isOwner
          })
        }
      })
    }).catch(err => {
      console.error('加载详情失败：', err)
    })
  },

  copyWechat: function () {
    wx.setClipboardData({
      data: this.data.item.contact_wechat,
      success: () => wx.showToast({ title: '微信号已复制', icon: 'success' })
    })
  },

  // 标记已租出（发布者）
  markRented: function () {
    wx.showModal({
      title: '确认已租出',
      content: '标记后房源将下架，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('sublet_items').doc(this.data.item._id).update({
            data: { status: 'rented' }
          }).then(() => {
            wx.showToast({ title: '已标记租出', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          })
        }
      }
    })
  },

  // 删除
  deleteItem: function () {
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('sublet_items').doc(this.data.item._id).remove().then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('删除失败：', err)
            wx.showToast({ title: '删除失败', icon: 'none' })
          })
        }
      }
    })
  }
})