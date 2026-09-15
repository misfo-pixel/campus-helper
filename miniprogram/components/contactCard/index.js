// 微信号显示成 abc****yz，完整的靠点「复制微信号」拿
function maskWechat(wechat) {
  if (!wechat) return ''
  const s = String(wechat)
  if (s.length <= 2) return s.charAt(0) + '****'
  if (s.length <= 5) return s.charAt(0) + '****' + s.charAt(s.length - 1)
  return s.slice(0, 3) + '****' + s.slice(-2)
}

Component({
  properties: {
    avatar: String,
    nickname: String,
    wechat: String,
    // 传了才把头像那块变成「进对方主页」的入口。二手详情页开，转租/任务页不开。
    linkToStore: Boolean
  },

  data: {
    maskedWechat: ''
  },

  observers: {
    wechat: function (wechat) {
      this.setData({ maskedWechat: maskWechat(wechat) })
    }
  },

  methods: {
    // 组件不自己跳转——它不知道该跳去哪个主页，交给用它的页面决定
    onTapProfile: function () {
      if (!this.data.linkToStore) return
      this.triggerEvent('viewstore')
    },

    copyWechat: function () {
      const wechat = this.data.wechat
      if (!wechat) {
        wx.showToast({ title: '对方还没填微信号', icon: 'none' })
        return
      }
      wx.setClipboardData({
        data: wechat,
        success: () => wx.showToast({ title: '微信号已复制', icon: 'success' })
      })
    }
  }
})
