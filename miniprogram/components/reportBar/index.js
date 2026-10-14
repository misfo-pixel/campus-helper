// 举报入口。挂在每条 UGC 内容的详情页底部。
// 微信要求 UGC 小程序必须让用户能就地举报，且举报要有人处理——
// 处理端在 pages/reports，云函数是 submitReport / getReports / handleReport。

const { ask } = require('../../utils/subscribe.js')
const { t } = require('../../i18n/index.js')
const { blockUser } = require('../../utils/blocks.js')

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
    targetType: String,   // item 闲置 / sublet 转租 / task 委托 / group 群组 / shop 店铺
    targetId: String,
    // 自己的内容不显示「屏蔽发布者」
    owner: Boolean
  },

  methods: {
    // 屏蔽发布者：App Store 要求有用户内容的应用能屏蔽骚扰者（见 cloudfunctions/userBlock）。
    // 屏蔽后这条内容就不该再看了，直接退回上一页
    onBlock: function () {
      blockUser({ targetType: this.data.targetType, targetId: this.data.targetId }).then(ok => {
        if (ok) setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }), 800)
      })
    },

    onReport: function () {
      wx.showActionSheet({
        itemList: REASONS.map(r => t(r)),   // 显示翻译，存进举报记录的还是中文原文
        success: res => this.submitReport(REASONS[res.tapIndex]),
        fail: () => { /* 用户点了取消，不用处理 */ }
      })
    },

    submitReport: function (reason) {
      // 举报的人是最想知道后续的，这一刻要授权成功率最高
      ask('reportResult')
      wx.showLoading({ title: t('提交中'), mask: true })
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
            title: t('举报已提交'),
            content: t('我们会尽快核实处理，感谢你帮忙维护社区环境。'),
            showCancel: false,
            confirmText: t('好的')
          })
        } else {
          wx.showToast({ title: t(r.message || '提交失败'), icon: 'none' })
        }
      }).catch(err => {
        wx.hideLoading()
        console.error('提交举报失败：', err)
        wx.showToast({ title: t('提交失败，请重试'), icon: 'none' })
      })
    }
  }
})
