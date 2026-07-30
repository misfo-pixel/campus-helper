const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 按 openid 返回某个用户的公开资料（只有昵称和头像，微信号不走这里）
exports.main = async (event, context) => {
  const openid = event.openid
  if (!openid) {
    return { success: false, message: '缺少 openid' }
  }

  try {
    const res = await db.collection('users')
      .where({ openid: openid })
      .field({ nickname: true, avatarUrl: true })
      .limit(1)
      .get()

    if (res.data.length === 0) {
      return { success: true, nickname: '', avatarUrl: '' }
    }
    const user = res.data[0]
    return { success: true, nickname: user.nickname || '', avatarUrl: user.avatarUrl || '' }
  } catch (err) {
    return { success: false, error: err }
  }
}
