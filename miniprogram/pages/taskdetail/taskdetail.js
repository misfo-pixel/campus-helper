const { fetchPublicProfile } = require('../../utils/user.js')

Page({
  data: {
    item: null,
    canDelete: false,
    isOwner: false,
    seller: { nickname: '', avatarUrl: '' }
  },

  onLoad: function (options) {
    const id = options.id
    const db = wx.cloud.database()

    db.collection('task_items').doc(id).get().then(res => {
      const item = res.data
      this.setData({ item: item })

      // 发布者的昵称和头像（现查，对方改了资料这里跟着变）
      fetchPublicProfile(item._openid).then(seller => this.setData({ seller: seller }))

      wx.cloud.callFunction({ name: 'login' }).then(loginRes => {
        if (loginRes.result.success) {
          const myOpenid = loginRes.result.openid
          const roles = loginRes.result.roles || []
          const isOwner = (myOpenid === item._openid)
          const isTaskAdmin = roles.includes('task_admin') || roles.includes('super_admin')
          this.setData({
            canDelete: isOwner || isTaskAdmin,
            isOwner: isOwner
          })
        }
      })
    }).catch(err => {
      console.error('加载详情失败：', err)
    })
  },

  // 标记已完成（发布者）
  markDone: function () {
    wx.showModal({
      title: '确认已完成',
      content: '标记后任务将下架，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('task_items').doc(this.data.item._id).update({
            data: { status: 'done' }
          }).then(() => {
            wx.showToast({ title: '已标记完成', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          }).catch(err => {
            console.error('标记失败：', err)
            wx.showToast({ title: '操作失败', icon: 'none' })
          })
        }
      }
    })
  },

  deleteItem: function () {
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定吗？',
      success: (res) => {
        if (res.confirm) {
          const db = wx.cloud.database()
          db.collection('task_items').doc(this.data.item._id).remove().then(() => {
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