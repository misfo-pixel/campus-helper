// 举报入口。挂在每条 UGC 内容的详情页底部。
// 微信要求 UGC 小程序必须让用户能就地举报，且举报要有人处理——
// 处理端在 pages/reports，云函数是 submitReport / getReports / handleReport。

const REASONS = [
  '虚假信息 / 诈骗',
  '色情低俗',
  '广告骚扰',
  '违法违规',
  '侵犯我的权益',
  '其他'
]

Component({
  properties: {
    targetType: String,   // item 闲置 / sublet 转租 / task 委托 / shop 店铺
    targetId: String
  },

  methods: {
    onReport: function () {
      wx.showActionSheet({
        itemList: REASONS,
        success: res => this.submitReport(REASONS[res.tapIndex]),
        fail: () => { /* 用户点了取消，不用处理 */ }
      })
    },

    submitReport: function (reason) {
      wx.showLoading({ title: '提交中', mask: true })
      wx.cloud.callFunction({
        name: 'submitReport',
        data: {
          targetType: this.data.targetType,
          targetId: this.data.targetId,
          reason: reason
        }
      }).then(res => {
        wx.hideLoading()
        const r = (res && res.result) || {}
        if (r.success) {
          wx.showModal({
            title: '举报已提交',
            content: '我们会尽快核实处理，感谢你帮忙维护社区环境。',
            showCancel: false,
            confirmText: '好的'
          })
        } else {
          wx.showToast({ title: r.message || '提交失败', icon: 'none' })
        }
      }).catch(err => {
        wx.hideLoading()
        console.error('提交举报失败：', err)
        wx.showToast({ title: '提交失败，请重试', icon: 'none' })
      })
    }
  }
})
