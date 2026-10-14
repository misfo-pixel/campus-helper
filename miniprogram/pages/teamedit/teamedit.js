// 建队 / 队伍设置 / 成员管理。
//
// 队伍自己定配送方案：有哪些服务地点、各收多少、每天几班。
// 外包给这支队伍的店长，买家看到的就是这套。
// 除此之外这里管队伍本身：叫什么、找谁、钱打到哪、谁在队里。

const { ensureContentOk } = require('../../utils/contentCheck.js')
const { t, f } = require('../../i18n/index.js')

Page({
  data: {
    loading: true,
    loadError: false,
    saving: false,
    isNew: true,
    role: null,
    team: null,
    members: [],

    name: '',
    description: '',
    contact_wechat: '',
    payment_note: '',
    create_code: ''
  },

  onShow: function () {
    this.load()
  },

  // 「读取失败」和「你还没有队伍」必须分开。
  // 云函数返回 success:false 时 r.team 同样是 undefined，不判 success 的话
  // 一次读取失败会被当成没队伍，静默渲染一张空白建队表单——已有队伍的队长
  // 会以为自己的队没了，还会去重新建一支（云函数那边会拦，但白跑一趟）。
  load: function () {
    wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}

      if (!r.success) {
        this.fail(r.message || '读取失败')
        return
      }

      const team = r.team

      if (!team) {
        this.setData({ isNew: true, loading: false, loadError: false })
        return
      }

      this.setData({
        isNew: false,
        loading: false,
        loadError: false,
        role: r.role,
        team: team,
        members: r.members || [],
        name: team.name || '',
        description: team.description || '',
        contact_wechat: team.contact_wechat || '',
        payment_note: team.payment_note || ''
      })
    }).catch(err => {
      console.error('读取队伍失败：', err)
      this.fail('读取失败')
    })
  },

  fail: function (message) {
    this.setData({ loading: false, loadError: true })
    wx.showToast({ title: t(message), icon: 'none' })
  },

  retry: function () {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    if (d.isNew && !d.create_code.trim()) {
      wx.showToast({ title: t('请填写开队码'), icon: 'none' })
      return
    }
    if (!d.name.trim()) {
      wx.showToast({ title: t('请填写队伍名称'), icon: 'none' })
      return
    }
    if (!d.contact_wechat.trim()) {
      wx.showToast({ title: t('请填写队长微信'), icon: 'none' })
      return
    }
    if (!d.payment_note.trim()) {
      wx.showToast({ title: t('请填写收款方式'), icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: t(d.isNew ? '创建中' : '保存中'), mask: true })

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
          create_code: d.create_code
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: t(r.message || '提交失败'), icon: 'none' })
        return
      }

      if (d.isNew) {
        // 没有核对这一步了：建完就能被店长选到
        wx.showModal({
          title: t('队伍建好了'),
          content: t('店长现在就能选到你们。有人发来配送请求时，会出现在配送工作台。'),
          showCancel: false,
          confirmText: t('知道了'),
          success: () => this.load()
        })
      } else {
        wx.showToast({ title: t('已保存'), icon: 'success' })
        this.load()
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存队伍失败：', err)
      wx.showToast({ title: t('保存失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  copyCode: function () {
    const code = this.data.team && this.data.team.join_code
    if (!code) return
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: t('邀请码已复制'), icon: 'success' })
    })
  },

  resetCode: function () {
    wx.showModal({
      title: t('重置邀请码'),
      content: t('换一个新码，旧码立刻失效。已经在队里的人不受影响。'),
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'resetCode' } }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: t('已重置'), icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: t(result.message || '重置失败'), icon: 'none' })
          }
        }).catch(err => {
          console.error('重置邀请码失败：', err)
          wx.showToast({ title: t('重置失败'), icon: 'none' })
        })
      }
    })
  },

  // 队长直接把人拉进来。
  // 配送工作台的入口对普通用户是隐藏的，队员自己找不到输邀请码的地方，
  // 所以这条路必须有。按微信号找人——对方得先在「编辑资料」里填过。
  addMember: function () {
    wx.showModal({
      title: t('添加队员'),
      editable: true,
      placeholderText: t('输入对方的微信号'),
      success: res => {
        if (!res.confirm || !res.content) return
        wx.showLoading({ title: t('添加中'), mask: true })
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'addMemberByWechat', wechat: res.content }
        }).then(r => {
          wx.hideLoading()
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: f('已添加 {0}', result.nickname), icon: 'none' })
            this.load()
          } else {
            wx.showModal({
              title: t('没能添加'),
              content: t(result.message || '添加失败'),
              showCancel: false
            })
          }
        }).catch(err => {
          wx.hideLoading()
          console.error('添加队员失败：', err)
          wx.showToast({ title: t('添加失败'), icon: 'none' })
        })
      }
    })
  },

  removeMember: function (e) {
    const openid = e.currentTarget.dataset.openid
    const nickname = e.currentTarget.dataset.nickname || t('这名队员')
    wx.showModal({
      title: t('移出队伍'),
      content: f('把{0}移出队伍？他已经领的单不会受影响。', nickname),
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'deliveryManage',
          data: { action: 'removeMember', openid: openid }
        }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: t('已移出'), icon: 'success' })
            this.load()
          } else {
            wx.showToast({ title: t(result.message || '操作失败'), icon: 'none' })
          }
        }).catch(err => {
          console.error('移除成员失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  },

  quitTeam: function () {
    wx.showModal({
      title: t('退出队伍'),
      content: t('退出后就看不到这个队的配送单了。确定吗？'),
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({ name: 'deliveryManage', data: { action: 'removeMember' } }).then(r => {
          const result = (r && r.result) || {}
          if (result.success) {
            wx.showToast({ title: t('已退出'), icon: 'success' })
            setTimeout(() => wx.navigateBack(), 800)
          } else {
            wx.showToast({ title: t(result.message || '操作失败'), icon: 'none' })
          }
        }).catch(err => {
          console.error('退出失败：', err)
          wx.showToast({ title: t('操作失败'), icon: 'none' })
        })
      }
    })
  }
})
