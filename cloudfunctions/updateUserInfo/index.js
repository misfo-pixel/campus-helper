const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    // 找到当前用户的记录，更新昵称、头像和微信号
    const res = await db.collection('users').where({ openid: openid }).get()
    if (res.data.length === 0) {
      return { success: false, message: '用户不存在' }
    }
    const user = res.data[0]

    // 只更新传上来的字段，没传的保持原样
    const data = {}
    if (event.nickname !== undefined) {
      data.nickname = event.nickname || user.nickname || '匿名用户'
    }
    if (event.wechat !== undefined) {
      data.wechat = event.wechat || ''
    }
    if (event.avatarUrl !== undefined) {
      data.avatarUrl = event.avatarUrl || ''
    }

    await db.collection('users').doc(user._id).update({ data: data })

    // 换了头像就把旧图删掉，避免云存储里堆一堆没人用的文件
    const oldAvatar = user.avatarUrl
    if (data.avatarUrl && oldAvatar && oldAvatar !== data.avatarUrl && oldAvatar.indexOf('cloud://') === 0) {
      try {
        await cloud.deleteFile({ fileList: [oldAvatar] })
      } catch (e) {
        // 删不掉不影响保存
      }
    }

    return { success: true, nickname: data.nickname, avatarUrl: data.avatarUrl }
  } catch (err) {
    return { success: false, error: err }
  }
}
