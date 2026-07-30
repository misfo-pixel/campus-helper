const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    // 找到当前用户的记录，更新昵称和微信号
    const res = await db.collection('users').where({ openid: openid }).get()
    if (res.data.length === 0) {
      return { success: false, message: '用户不存在' }
    }
    await db.collection('users').doc(res.data[0]._id).update({
      data: {
        nickname: event.nickname || res.data[0].nickname,
        wechat: event.wechat || ''
      }
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err }
  }
}