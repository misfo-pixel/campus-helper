// 统一的用户资料读取入口。
// 云函数如果还没重新部署，这里会自动回落到直接查 users 表，
// 所以页面不用关心云函数的部署状态。

const PLACEHOLDER_NICKNAME = '匿名用户'

// 建号时写的占位昵称不当成真昵称，交给页面显示自己的兜底文案
function cleanNickname(name) {
  if (!name || name === PLACEHOLDER_NICKNAME) return ''
  return name
}

function queryUserDoc(openid) {
  if (!openid) return Promise.resolve({})
  return wx.cloud.database().collection('users')
    .where({ openid: openid })
    .get()
    .then(res => res.data[0] || {})
    .catch(err => {
      console.error('查询用户资料失败：', err)
      return {}
    })
}

// 当前登录用户：openid、roles + 昵称/头像/微信号
function fetchMyProfile() {
  return wx.cloud.callFunction({ name: 'login' }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) throw new Error('login 云函数返回失败')

    const profile = {
      openid: r.openid,
      roles: r.roles || [],
      isNew: !!r.isNew,
      nickname: cleanNickname(r.nickname),
      avatarUrl: r.avatarUrl || '',
      wechat: r.wechat || ''
    }

    // 老版本 login 云函数不返回资料字段，回落到直接查库
    if (r.nickname !== undefined) return profile
    return queryUserDoc(r.openid).then(doc => {
      profile.nickname = cleanNickname(doc.nickname)
      profile.avatarUrl = doc.avatarUrl || ''
      profile.wechat = doc.wechat || ''
      return profile
    })
  })
}

// 别人的公开资料（昵称 + 头像），详情页显示发布者用
function fetchPublicProfile(openid) {
  if (!openid) return Promise.resolve({ nickname: '', avatarUrl: '' })

  return wx.cloud.callFunction({
    name: 'getUserPublic',
    data: { openid: openid }
  }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) throw new Error('getUserPublic 云函数返回失败')
    return { nickname: cleanNickname(r.nickname), avatarUrl: r.avatarUrl || '' }
  }).catch(() => {
    // 云函数还没部署就直接查库
    return queryUserDoc(openid).then(doc => ({
      nickname: cleanNickname(doc.nickname),
      avatarUrl: doc.avatarUrl || ''
    }))
  })
}

const GUIDE_FLAG = 'profileGuideShown'

// 头像或昵称还没填过就引导一次，提示过就不再打扰。
// 传已经拿到的 profile 进来，避免多打一次 login。
function guideProfileSetupOnce(profile) {
  if (!profile) return
  if (profile.nickname && profile.avatarUrl) return
  if (wx.getStorageSync(GUIDE_FLAG)) return

  wx.setStorageSync(GUIDE_FLAG, true)
  wx.showModal({
    title: '完善资料',
    content: '设置头像和昵称，方便同学认出你',
    confirmText: '去设置',
    cancelText: '以后再说',
    success: res => {
      if (res.confirm) wx.navigateTo({ url: '/pages/editprofile/editprofile' })
    }
  })
}

module.exports = {
  fetchMyProfile: fetchMyProfile,
  fetchPublicProfile: fetchPublicProfile,
  guideProfileSetupOnce: guideProfileSetupOnce
}
