const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const res = await db.collection('users').where({ openid: openid }).get()

    if (res.data.length === 0) {
      // 新用户：默认 roles 为 ['student']
      await db.collection('users').add({
        data: {
          openid: openid,
          nickname: event.nickname || '匿名用户',
          roles: ['student'],
          created_at: new Date()
        }
      })
      return { success: true, openid: openid, roles: ['student'], isNew: true }
    } else {
      // 老用户：返回 roles。兼容老数据（如果只有 role 没有 roles）
      const user = res.data[0]
      let roles = user.roles
      if (!roles) {
        // 老数据兼容：把旧的单个 role 转成数组
        roles = user.role ? [user.role] : ['student']
      }
      return { success: true, openid: openid, roles: roles, isNew: false }
    }
  } catch (err) {
    return { success: false, error: err }
  }
}