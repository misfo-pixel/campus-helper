Page({
  data: {
    myOrders: [],
    statusText: {
      'pending_payment': '待付款',
      'pending_confirm': '待确认',
      'confirmed': '已确认',
      'delivering': '配送中',
      'delivered': '已送达'
    }
  },

  onShow: function () {
    const db = wx.cloud.database()
    // 查询 orders 表；云开发会自动只返回当前用户 _openid 的记录
    db.collection('orders').orderBy('created_at', 'desc').get().then(res => {
      console.log('我的订单：', res.data)
      this.setData({
        myOrders: res.data
      })
    }).catch(err => {
      console.error('查询订单失败：', err)
    })
  },
  
  uploadProof: function (e) {
    const orderId = e.currentTarget.dataset.id
    const db = wx.cloud.database()
  
    // 1. 让用户选一张图片
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (chooseRes) => {
        const filePath = chooseRes.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中...' })
  
        // 2. 上传到云存储
        wx.cloud.uploadFile({
          cloudPath: 'proofs/' + orderId + '_' + Date.now() + '.jpg',  // 存储里的文件名
          filePath: filePath,
          success: (uploadRes) => {
            console.log('上传成功，文件ID：', uploadRes.fileID)
  
            // 3. 把图片地址存进订单，状态改为待确认
            db.collection('orders').doc(orderId).update({
              data: {
                payment_proof_url: uploadRes.fileID,
                status: 'pending_confirm'
              }
            }).then(() => {
              wx.hideLoading()
              wx.showToast({ title: '上传成功！', icon: 'success' })
              this.onShow()  // 刷新列表
            })
          },
          fail: (err) => {
            wx.hideLoading()
            console.error('上传失败：', err)
            wx.showToast({ title: '上传失败', icon: 'none' })
          }
        })
      }
    })
  },
})