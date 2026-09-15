const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  // 保温调用：只是为了让容器保持活着，不该真的执行业务。
  // login 尤其危险——云函数互调拿不到 OPENID，不拦的话会往 users 表
  // 插一条 openid 为空的垃圾记录。
  if (event && event.__warmup) return { success: true, warmed: true }

  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const res = await db.collection('users').where({ openid: openid }).get()

    if (res.data.length === 0) {
      // 新用户：默认 roles 为 ['student']
      const nickname = event.nickname || '匿名用户'
      const avatarUrl = event.avatarUrl || ''
      const added = await db.collection('users').add({
        data: {
          openid: openid,
          nickname: nickname,
          avatarUrl: avatarUrl,
          wechat: '',
          roles: ['student'],
          created_at: new Date()
        }
      })
      return {
        success: true,
        openid: openid,
        // uid 是这条 users 文档的随机 _id，用作对外可分享的编号。
        // openid 是微信给的永久身份标识，不该出现在会被转发的链接里。
        uid: added._id,
        roles: ['student'],
        isNew: true,
        nickname: nickname,
        avatarUrl: avatarUrl,
        wechat: ''
      }
    } else {
      // 老用户：返回 roles。兼容老数据（如果只有 role 没有 roles）
      const user = res.data[0]
      let roles = user.roles
      if (!roles) {
        // 老数据兼容：把旧的单个 role 转成数组
        roles = user.role ? [user.role] : ['student']
      }
      return {
        success: true,
        openid: openid,
        uid: user._id,
        roles: roles,
        isNew: false,
        nickname: user.nickname || '',
        avatarUrl: user.avatarUrl || '',
        wechat: user.wechat || ''
      }
    }
  } catch (err) {
    return { success: false, error: err }
  }
}
