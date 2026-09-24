// 帖子留言板。挂在二手 / 转租 / 委托三个详情页底部。
//
// 公开的异步问答，不是私聊：所有人可见，所以治理上和帖子本身同一类
// （机检 + 举报 + 删除），不用把平台升级成「通信服务提供者」。
// 云函数在 cloudfunctions/messages。
//
// 一问一答做成平铺的「回复 小明：…」，不做嵌套树——手机上树形既难点又难读，
// 而「还在吗」「在的」这种对话两层就到头了。

const { ensureContentOk } = require('../../utils/contentCheck.js')
const { ask } = require('../../utils/subscribe.js')

// 和 components/reportBar 里的那份保持一致
const REASONS = ['虚假信息 / 诈骗', '色情低俗', '广告骚扰', '违法违规', '侵犯我的权益', '其他']

Component({
  properties: {
    targetType: String,     // item / sublet / task
    targetId: String
  },

  data: {
    loading: true,
    messages: [],
    isOwner: false,         // 我是不是楼主，决定输入框的占位文案
    draft: '',
    canSend: false,         // 草稿有字才把发送点亮。WXML 里调不了 trim，只能在这里算
    focus: false,           // 点「回复」时直接弹键盘
    replyToName: '',        // 非空时这条留言是「回复某人」
    replyToId: '',          // 被回复的那条留言，服务端靠它找到作者发通知
    sending: false
  },

  observers: {
    // 详情页是先画壳再拉数据的，targetId 会从空变成真实 id
    targetId: function (id) {
      if (id) this.load()
    }
  },

  methods: {
    load: function () {
      wx.cloud.callFunction({
        name: 'messages',
        data: {
          action: 'list',
          targetType: this.data.targetType,
          targetId: this.data.targetId
        }
      }).then(res => {
        const r = (res && res.result) || {}
        this.setData({
          messages: r.success ? (r.messages || []) : [],
          isOwner: r.isOwner === true,
          loading: false
        })
      }).catch(err => {
        console.error('读取留言失败：', err)
        this.setData({ loading: false })
      })
    },

    onInput: function (e) {
      const v = e.detail.value
      this.setData({ draft: v, canSend: !!v.trim() })
    },

    // focus 是一次性的：失焦后要落回 false，下次点「回复」才能再触发
    onBlur: function () {
      this.setData({ focus: false })
    },

    // 点某条留言的「回复」：名字当前缀显示，id 交给服务端找人发通知。
    // 展示上仍然平铺，不建父子关系。
    replyTo: function (e) {
      const ds = e.currentTarget.dataset
      this.setData({ replyToName: ds.name || '', replyToId: ds.id || '', focus: true })
    },

    cancelReply: function () {
      this.setData({ replyToName: '', replyToId: '' })
    },

    send: async function () {
      const d = this.data
      if (d.sending) return

      const content = (d.draft || '').trim()
      if (!content) {
        wx.showToast({ title: '说点什么吧', icon: 'none' })
        return
      }

      // 趁用户正等着回复的这一刻要授权——这时候他最愿意点「允许」，
      // 有人回复他时就用这张票通知他。拿不到也无所谓，留言本身照发。
      //
      // 必须在第一个 await 之前调、而且不等它：原来放在机检之后，
      // 中间隔了一次云函数往返，真机上报 can only be invoked by user TAP
      // gesture，弹窗根本不出来。
      ask('inquiry')

      this.setData({ sending: true })
      wx.showLoading({ title: '发送中', mask: true })

      try {
        // 公开可见的内容，一律先过机检
        if (!(await ensureContentOk({ texts: [content] }))) return

        const res = await wx.cloud.callFunction({
          name: 'messages',
          data: {
            action: 'add',
            targetType: d.targetType,
            targetId: d.targetId,
            content: content,
            replyToName: d.replyToName,
            replyToId: d.replyToId
          }
        })

        wx.hideLoading()
        const r = (res && res.result) || {}
        if (!r.success) {
          wx.showToast({ title: r.message || '发送失败', icon: 'none' })
          return
        }

        this.setData({ draft: '', canSend: false, replyToName: '', replyToId: '' })
        this.load()
      } catch (err) {
        wx.hideLoading()
        console.error('发送留言失败：', err)
        wx.showToast({ title: '发送失败，请重试', icon: 'none' })
      } finally {
        this.setData({ sending: false })
      }
    },

    // 留言是公开 UGC，必须能就地举报——这是微信对 UGC 小程序的硬性要求。
    // 走的是和帖子同一套：submitReport 存单，管理员在 pages/reports 里处理。
    report: function (e) {
      const id = e.currentTarget.dataset.id
      wx.showActionSheet({
        itemList: REASONS,
        success: res => {
          ask('reportResult')
          wx.cloud.callFunction({
            name: 'submitReport',
            data: { targetType: 'message', targetId: id, reason: REASONS[res.tapIndex] }
          }).then(r2 => {
            const r = (r2 && r2.result) || {}
            wx.showToast({
              title: r.success ? '已提交，我们会尽快核实' : (r.message || '提交失败'),
              icon: 'none'
            })
          }).catch(err => {
            console.error('举报留言失败：', err)
            wx.showToast({ title: '提交失败', icon: 'none' })
          })
        },
        fail: () => { /* 用户点了取消 */ }
      })
    },

    remove: function (e) {
      const id = e.currentTarget.dataset.id
      wx.showModal({
        title: '删除留言',
        content: '删除后无法恢复，确定吗？',
        success: res => {
          if (!res.confirm) return
          wx.cloud.callFunction({
            name: 'messages',
            data: { action: 'remove', messageId: id }
          }).then(r2 => {
            const r = (r2 && r2.result) || {}
            if (r.success) {
              this.load()
            } else {
              wx.showToast({ title: r.message || '删除失败', icon: 'none' })
            }
          }).catch(err => {
            console.error('删除留言失败：', err)
            wx.showToast({ title: '删除失败', icon: 'none' })
          })
        }
      })
    }
  }
})
