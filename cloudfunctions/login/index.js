const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  // 拿到当前用户的 openid（云函数里可靠获取）
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    // 查 users 表里有没有这个用户
    const res = await db.collection('users').where({ openid: openid }).get()

    if (res.data.length === 0) {
      // 没有 → 默认角色 student，创建，明确存 openid
      await db.collection('users').add({
        data: {
          openid: openid,          // 明确存用户的 openid
          nickname: event.nickname || '匿名用户',
          role: 'student',
          created_at: new Date()
        }
      })
      return { success: true, openid: openid, role: 'student', isNew: true }
    } else {
      // 有 → 返回已有角色
      return { success: true, openid: openid, role: res.data[0].role, isNew: false }
    }
  } catch (err) {
    return { success: false, error: err }
  }
}