Page({
  data: {
    types: ['功能建议', 'Bug 报告', '内容问题', '其他'],
    typeIndex: 0,
    content: '',
    contact: '',
    submitting: false
  },
  onTypeChange(e) { this.setData({ typeIndex: e.detail.value }) },
  onContentInput(e) { this.setData({ content: e.detail.value }) },
  onContactInput(e) { this.setData({ contact: e.detail.value }) },

  async submit() {
    const content = this.data.content.trim()
    if (!content) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' })
      return
    }
    if (this.data.submitting) return          // 防止连点重复提交
    this.setData({ submitting: true })
    try {
      const db = wx.cloud.database()
      await db.collection('feedback').add({
        data: {
          type: this.data.types[this.data.typeIndex],
          content: content,
          contact: this.data.contact.trim(),
          createTime: db.serverDate()          // serverDate = 用服务器时间,比客户端时间可靠
        }
      })
      // 说明:从客户端 add 时,微信云开发会自动给这条记录写上 _openid,
      // 所以你不用手动传身份,后台能看出是谁提交的。
      wx.showToast({ title: '已提交,谢谢!', icon: 'success' })
      this.setData({ content: '', contact: '', typeIndex: 0 })
      setTimeout(() => wx.navigateBack(), 1200)
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '提交失败,请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })       // 无论成败都解锁按钮
    }
  }
})