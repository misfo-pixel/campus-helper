// 屏蔽用户（见 cloudfunctions/userBlock）。
//
// 列表页是前端直连数据库查的，拿不到作者，所以云函数把「被屏蔽的人发的内容 _id」算好发过来，
// 这里存一份在本地，列表页拿到数据后过一遍 filterHidden。留言在 messages 云函数里已经过滤了。
// 名单在启动时（app.js）和每次屏蔽 / 取消屏蔽后刷新。
const { t } = require('../i18n/index.js')

const KEY = 'blocks.v1'
let memo = null

function read() {
  if (memo) return memo
  try { memo = wx.getStorageSync(KEY) || null } catch (e) { memo = null }
  return memo
}

function refresh() {
  return wx.cloud.callFunction({ name: 'userBlock', data: { action: 'list' } }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) throw new Error(r.message || 'userBlock list failed')
    memo = { users: r.users || [], hidden: r.hidden || {} }
    try { wx.setStorageSync(KEY, memo) } catch (e) { /* 存不上下次再拉 */ }
    return memo
  })
}

function blockedUsers() {
  return (read() || {}).users || []
}

// type: item / sublet / task / group / shop；key 是列表里放内容 _id 的字段
function filterHidden(type, list, key) {
  const ids = ((read() || {}).hidden || {})[type] || []
  if (!ids.length || !Array.isArray(list)) return list
  const k = key || '_id'
  return list.filter(x => ids.indexOf(x[k]) === -1)
}

// target: { targetType, targetId } 或 { uid }。确认后屏蔽，成功 resolve(true)
function blockUser(target) {
  return new Promise(resolve => {
    wx.showModal({
      title: t('屏蔽这个用户？'),
      content: t('屏蔽后，你将看不到对方发布的内容和留言，对方不会收到通知。可以在「我的 → 已屏蔽的用户」里取消。'),
      confirmText: t('屏蔽'),
      confirmColor: '#C8102E',
      success: res => {
        if (!res.confirm) return resolve(false)
        wx.showLoading({ title: t('处理中'), mask: true })
        wx.cloud.callFunction({ name: 'userBlock', data: Object.assign({ action: 'block' }, target) })
          .then(r => {
            const result = (r && r.result) || {}
            if (!result.success) throw new Error(result.message || '屏蔽失败')
            return refresh()
          })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: t('已屏蔽'), icon: 'success' })
            resolve(true)
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: t(err.message || '屏蔽失败'), icon: 'none' })
            resolve(false)
          })
      }
    })
  })
}

function unblockUser(uid) {
  return wx.cloud.callFunction({ name: 'userBlock', data: { action: 'unblock', uid: uid } })
    .then(r => {
      const result = (r && r.result) || {}
      if (!result.success) throw new Error(result.message || '操作失败')
      return refresh()
    })
}

module.exports = { refresh, blockedUsers, filterHidden, blockUser, unblockUser }
