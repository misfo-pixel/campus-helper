// 意见反馈处理台（管理员）。
//
// 建这个页面是因为 pages/feedback 原本是断头路：用户提交后没人看得到，
// 也没法回复。现在回复会顺带给对方发一条订阅消息，闭环才算合上。
// 权限在 feedbackManage 云函数里服务端校验，前端这层只是入口。

const { ask } = require('../../utils/subscribe.js')
const { formatTime } = require('../../utils/date.js')

Page({
  data: {
    items: [],
    status: 'pending',
    loading: true
  },

  onShow: function () {
    // 管理员每来一次就要一次授权，攒的额度供第二天的每日汇总用
    ask('adminPending')
    this.load()
  },

  switchStatus: function (e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.status) return
    this.setData({ status: status, items: [], loading: true }, () => this.load())
  },

  load: function () {
    wx.cloud.callFunction({
      name: 'feedbackManage',
      data: { action: 'list', status: this.data.status }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }
      this.setData({
        items: (r.items || []).map(it => Object.assign({}, it, {
          timeText: formatTime(it.createTime),
          replyTimeText: formatTime(it.replied_at)
        })),
        loading: false
      })
    }).catch(err => {
      console.error('读取反馈失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  reply: function (e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '回复反馈',
      editable: true,
      placeholderText: '写一句回复，对方会收到通知',
      success: res => {
        if (!res.confirm) return
        const text = (res.content || '').trim()
        if (!text) {
          wx.showToast({ title: '回复不能为空', icon: 'none' })
          return
        }
        wx.showLoading({ title: '提交中', mask: true })
        wx.cloud.callFunction({
          name: 'feedbackManage',
          data: { action: 'reply', id: id, reply: text }
        }).then(r2 => {
          wx.hideLoading()
          const r = (r2 && r2.result) || {}
          if (r.success) {
            wx.showToast({ title: '已回复', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: r.message || '回复失败', icon: 'none' })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('回复反馈失败：', err)
          wx.showToast({ title: '回复失败', icon: 'none' })
        })
      }
    })
  },

  copyContact: function (e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  }
})
