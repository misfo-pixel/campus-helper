const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 管理员拉举报列表。走云函数是因为 reports 表对小程序端应该是完全不可读的，
// 只有这里能绕过权限，顺便把「是不是管理员」在服务端确认一遍。
exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const status = event.status || 'pending'

  try {
    const me = await db.collection('users').where({ openid: openid }).limit(1).get()
    const roles = (me.data[0] && me.data[0].roles) || []
    if (!roles.includes('super_admin') && !roles.includes('market_admin')) {
      return { success: false, message: '没有权限' }
    }

    const res = await db.collection('reports')
      .where({ status: status })
      .orderBy('created_at', 'desc')
      .limit(100)
      .get()

    return { success: true, reports: res.data }
  } catch (err) {
    console.error('读取举报列表失败：', err)
    return { success: false, message: '读取失败' }
  }
}
