const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 每天给管理员推一条「你有 N 条待处理」。
//
// 为什么是汇总而不是一事一条：订阅消息一次授权只能发一条。
// 要是每来一条举报就推一次，管理员得反复点「允许」才收得到下一条——
// 攒下的授权额度撑不过一天。汇总成一条，一次授权管一整天。
//
// 触发器写的是北京时间 22:00（云函数定时器只认 UTC+8），
// 对应明尼苏达夏令时早上 9 点、冬令时早上 8 点。跨时区没法两头都正，
// 差一小时无所谓——这是个每日提醒，不是闹钟。

const ADMIN_ROLES = ['super_admin', 'market_admin']

exports.main = async () => {
  try {
    const pair = await Promise.all([
      db.collection('reports').where({ status: 'pending' }).count(),
      db.collection('feedback').where({ replied: _.neq(true) }).count()
    ])
    const reportCount = pair[0].total
    const feedbackCount = pair[1].total
    const total = reportCount + feedbackCount

    // 一条都没有就不打扰。每天准点推一条「你有 0 条待处理」
    // 是让人关掉通知最快的方式。
    if (total === 0) return { success: true, skipped: 'nothing pending' }

    const admins = await db.collection('users')
      .where({ roles: _.in(ADMIN_ROLES) })
      .field({ openid: true })
      .limit(50)
      .get()

    if (!admins.data.length) return { success: true, skipped: 'no admin' }

    const now = new Date()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    const timeText = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())

    const parts = []
    if (reportCount) parts.push('举报 ' + reportCount + ' 条')
    if (feedbackCount) parts.push('反馈 ' + feedbackCount + ' 条')

    // 串行发。管理员最多个位数，没必要并发，而且一个人失败不该影响其他人
    let sent = 0
    for (const admin of admins.data) {
      try {
        const res = await cloud.callFunction({
          name: 'sendSubscribe',
          data: {
            tpl: 'adminPending',
            toUser: admin.openid,
            page: 'pages/reports/reports',
            data: {
              count: total,
              tip: parts.join(' · '),
              time: timeText
            }
          }
        })
        if (res && res.result && res.result.success) sent++
      } catch (e) {
        console.warn('管理员汇总推送失败：', admin.openid, e)
      }
    }

    return { success: true, reportCount: reportCount, feedbackCount: feedbackCount, sent: sent }
  } catch (err) {
    console.error('adminDigest 失败：', err)
    return { success: false }
  }
}
