// 统一的用户资料读取入口。
// 云函数如果还没重新部署，这里会自动回落到直接查 users 表，
// 所以页面不用关心云函数的部署状态。

const PLACEHOLDER_NICKNAME = '匿名用户'

// 上次登录拿到的资料存一份在手机本地。下次打开小程序时先用这份立刻渲染，
// 同时后台再去问一次服务端，回来了再悄悄换掉。这套策略叫
// stale-while-revalidate（先用旧的，同时验证）——浏览器缓存、CDN 都这么干。
//
// 缓存里的 roles 可能是过期的（比如管理员权限刚被撤掉），界面上会短暂多显示
// 一个入口。这只是显示问题，不是安全问题：真正的权限校验在云函数里，
// 前端拿着过期的 roles 也调不动。
// key 里带版本号：profile 的结构变了（这次加了 uid）就换一个 key，
// 老缓存自然读不到，会走一次网络重建。比写迁移逻辑简单得多。
const PROFILE_CACHE_KEY = 'cachedProfile.v2'

function readCachedProfile() {
  try {
    return wx.getStorageSync(PROFILE_CACHE_KEY) || null
  } catch (e) {
    return null   // 存储被禁用或读坏了，当没有缓存处理即可
  }
}

function writeCachedProfile(profile) {
  try {
    wx.setStorageSync(PROFILE_CACHE_KEY, profile)
  } catch (e) {
    // 写不进去不影响功能，下次照样走网络
  }
}

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
      uid: r.uid || '',          // 对外可分享的编号，见 cloudfunctions/login
      roles: r.roles || [],
      isNew: !!r.isNew,
      nickname: cleanNickname(r.nickname),
      avatarUrl: r.avatarUrl || '',
      wechat: r.wechat || ''
    }

    // 老版本 login 云函数不返回资料字段，回落到直接查库
    if (r.nickname !== undefined) {
      writeCachedProfile(profile)
      return profile
    }
    return queryUserDoc(r.openid).then(doc => {
      profile.nickname = cleanNickname(doc.nickname)
      profile.avatarUrl = doc.avatarUrl || ''
      profile.wechat = doc.wechat || ''
      // 老云函数连 uid 都不返，这里一并补上：uid 就是 users 文档的 _id。
      // 漏了它，分享/预览公开主页会一直拿不到 uid。
      profile.uid = profile.uid || doc._id || ''
      writeCachedProfile(profile)
      return profile
    })
  })
}

// 页面要「我的资料」时用这个，不要再调 fetchMyProfile：
// 那会多打一次 login（跨太平洋一趟往返），新用户还可能和 app.js 里那次登录撞车——
// 两边同时查不到记录、各建一条，同一个人就有了两条 users。
// 本地缓存优先（app.js 登录回来、editprofile 保存时都会更新它），没有缓存再等 app.js 那一次登录
function myProfile() {
  const cached = readCachedProfile()
  if (cached && cached.openid && cached.uid) return Promise.resolve(cached)
  const app = getApp()
  return (app && app.globalData && app.globalData.profileReady) || fetchMyProfile()
}

// 别人的公开资料（昵称 + 头像），详情页显示发布者用
function fetchPublicProfile(openid) {
  if (!openid) return Promise.resolve({ nickname: '', avatarUrl: '', uid: '' })

  return wx.cloud.callFunction({
    name: 'getUserPublic',
    data: { openid: openid }
  }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) throw new Error('getUserPublic 云函数返回失败')
    return { nickname: cleanNickname(r.nickname), avatarUrl: r.avatarUrl || '', uid: r.uid || '' }
  }).catch(() => {
    // 云函数还没部署就直接查库
    return queryUserDoc(openid).then(doc => ({
      nickname: cleanNickname(doc.nickname),
      avatarUrl: doc.avatarUrl || '',
      uid: doc._id || ''
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
  myProfile: myProfile,
  readCachedProfile: readCachedProfile,
  writeCachedProfile: writeCachedProfile,
  fetchPublicProfile: fetchPublicProfile,
  guideProfileSetupOnce: guideProfileSetupOnce
}
