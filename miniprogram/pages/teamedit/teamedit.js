// 建队 / 队伍设置 / 成员管理。
//
// 队伍自己定配送方案：有哪些服务地点、各收多少、每天几班。
// 外包给这支队伍的店长，买家看到的就是这套。
// 除此之外这里管队伍本身：叫什么、找谁、钱打到哪、谁在队里。

const { ensureContentOk } = require('../../utils/contentCheck.js')

Page({
  data: {
    loading: true,
    saving: false,
    isNew: true,
    role: null,
    team: null,
    members: [],

    name: '',
    description: '',
    contact_wechat: '',
    payment_note: '',

    planPoints: [],
    planBatches: []
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}
      const team = r.team

      if (!team) {
        this.setData({ isNew: true, loading: false })
        return
      }

      this.setData({
        isNew: false,
        loading: false,
        role: r.role,
        team: team,
        members: r.members || [],
        name: team.name || '',
        description: team.description || '',
        contact_wechat: team.contact_wechat || '',
        payment_note: team.payment_note || '',
        planPoints: team.pickup_points || [],
        planBatches: team.batches || []
      })
    }).catch(err => {
      console.error('读取队伍失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onPlanChange: function (e) {
    this.setData({ planPoints: e.detail.points, planBatches: e.detail.batches })
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    if (!d.name.trim()) {
      wx.showToast({ title: '请填写队伍名称', icon: 'none' })
      return
    }
    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: '请填写队长微信', icon: 'none' })
      return
    }
    if (!d.payment_note.trim()) {
      wx.showToast({ title: '请填写收款方式', icon: 'none' })
      return
    }

    const points = (d.planPoints || []).filter(p => String(p.name || '').trim())
    if (!points.length) {
      wx.showToast({ title: '至少要设一个服务地点', icon: 'none' })
      return
    }
    const names = points.map(p => p.name.trim())
    if (new Set(names).size !== names.length) {
      wx.showToast({ title: '服务地点名字不能重复', icon: 'none' })
      return
    }
    // 场次的日期只校验填没填，不校验是不是过去的日子——
    // 否则场次一过期，队长连改队伍信息、换收款方式都保存不了
    const batch = (d.planBatches || [])[0]
    if (!batch || !batch.date) {
      wx.showToast({ title: '请选择服务时间的日期', icon: 'none' })
      return
    }
    if (batch.deliver_time <= batch.cutoff) {
      wx.showToast({ title: '送达时间要晚于截单时间', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: d.isNew ? '提交中' : '保存中', mask: true })

    try {
      // 队伍名和简介会展示给店长看，属于 UGC
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.contact_wechat, d.payment_note]
      }))) return

      const res = await wx.cloud.callFunction({
        name: 'deliveryManage',
        data: {
          action: d.isNew ? 'create' : 'update',
          name: d.name,
          description: d.description,
          contact_wechat: d.contact_wechat,
          payment_note: d.payment_note,
          pickup_points: d.planPoints,
          batches: d.planBatches
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '提交失败', icon: 'none' })
        return
      }

      if (d.isNew) {
        wx.showModal({
          title: '已提交',
          content: '队伍申请已提交，等超管审核通过后，店长就能选择把配送外包给你们。',
          showCancel: false,
          success: () => this.load()
        })
      } else {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.load()
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存队伍失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  copyCode: function () {
    const code = this.data.team && this.data.team.join_code
    if (!code) return
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    })
  },

  resetCode: function () {
    wx.showModal({
      title: '重置邀请码',
      content: '换一个新码，旧码立刻失效。已经在队里的人不受影响。',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'resetCode' } }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已重置', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '重置失败', icon: 'none' })
          }
        }).catch(err => {
          console.error('重置邀请码失败：', err)
          wx.showToast({ title: '重置失败', icon: 'none' })
        })
      }
    })
  },

  // 队长直接把人拉进来。
  // 配送工作台的入口对普通用户是隐藏的，队员自己找不到输邀请码的地方，
  // 所以这条路必须有。按微信号找人——对方得先在「编辑资料」里填过。
  addMember: function () {
    wx.showModal({
      title: '添加队员',
      editable: true,
      placeholderText: '输入对方的微信号',
      success: res => {
        if (!res.confirm || !res.content) return
        wx.showLoading({ title: '添加中', mask: true })
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'addMemberByWechat', wechat: res.content }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已添加 ' + result.nickname, icon: 'none' })
            this.load()
          } else {
            wx.showModal({
              title: '没能添加',
              content: result.message || '添加失败',
              showCancel: false
            })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('添加队员失败：', err)
          wx.showToast({ title: '添加失败', icon: 'none' })
        })
      }
    })
  },

  removeMember: function (e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || '这名队员'
    wx.showModal({
      title: '移出队伍',
      content: '把' + nickname + '移出队伍？他已经领的单不会受影响。',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'removeMember', openid: openid }
        }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已移出', icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: result.message || '操作失败', icon: 'none' })
          }
        }).catch(err => {
          console.error('移除成员失败：', err)
          wx.showToast({ title: '操作失败', icon: 'none' })
        })
      }
    })
  },

  quitTeam: function () {
    wx.showModal({
      title: '退出队伍',
      content: '退出后就看不到这个队的配送单了。确定吗？',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'removeMember' } }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: '已退出', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 800)
          } else {
            wx.showToast({ title: result.message || '操作失败', icon: 'none' })
          }
        }).catch(err => {
          console.error('退出失败：', err)
          wx.showToast({ title: '操作失败', icon: 'none' })
        })
      }
    })
  }
})
