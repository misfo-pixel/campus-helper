const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 意见反馈的管理端：拉列表 + 回复。
//
// 在这个云函数出现之前，pages/feedback 是一条断头路：用户提交后写进 feedback
// 集合就没下文了，小程序里没有任何地方能看到它，更没法回复。运营只能去
// 云开发控制台翻数据库——等于这个入口对用户是个许愿池。
//
// 和 getReports 同一个道理走云函数：feedback 表对小程序端应该完全不可读
// （里面有用户留的联系方式），只有这里能绕过权限，顺便在服务端确认管理员身份。

async function isAdmin(openid) {
  if (!openid) return false
  const res = await db.collection('users')
    .where({ openid: openid }).field({ roles: true }).limit(1).get()
  const roles = (res.data[0] && res.data[0].roles) || []
  return roles.indexOf('super_admin') !== -1 || roles.indexOf('market_admin') !== -1
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID

  try {
    if (!(await isAdmin(openid))) return { success: false, message: '没有权限' }

    switch (event.action) {

      case 'list': {
        // status: pending 待回复 / replied 已回复
        const replied = event.status === 'replied'
        const res = await db.collection('feedback')
          .where({ replied: replied ? true : db.command.neq(true) })
          .orderBy('createTime', 'desc')
          .limit(100)
          .get()
        return { success: true, items: res.data }
      }

      case 'reply': {
        const reply = String(event.reply || '').trim().slice(0, 300)
        if (!event.id || !reply) return { success: false, message: '请填写回复内容' }

        const doc = await db.collection('feedback').doc(event.id).get()
        const fb = doc.data
        if (!fb) return { success: false, message: '反馈不存在' }

        await db.collection('feedback').doc(event.id).update({
          data: {
            reply: reply,
            replied: true,
            replied_at: new Date(),
            replied_by: openid
          }
        })

        // 通知提交人。反馈是小程序端 add 的，所以归属在 _openid 上。
        // 发不出去很正常（对方没授权、票用完），不能让它影响回复本身。
        if (fb._openid) {
          try {
            await cloud.callFunction({
              name: 'sendSubscribe',
              data: {
                tpl: 'feedbackReply',
                toUser: fb._openid,
                page: 'pages/feedback/feedback',
                data: {
                  reply: reply,
                  kind: fb.type || '其他',
                  time: new Date().toLocaleString('zh-CN', { hour12: false })
                }
              }
            })
          } catch (e) {
            console.warn('反馈回复通知发送失败（不影响回复）：', e)
          }
        }

        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + event.action }
    }
  } catch (err) {
    console.error('feedbackManage 失败：', event.action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
