const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    const today = new Date()
    const todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0')

    let expiredCount = 0

    // 1. 二手：expire_date 过期的下架。
    // 下架日期是选填，没填存的是空串 ''——按字符串比 '' 小于任何日期，
    // 不排除掉的话，没填日期的帖子第二天凌晨就会被当成过期下架
    const _ = db.command
    const items = await db.collection('secondhand_items')
      .where({ status: 'on_sale', expire_date: _.gt('').and(_.lt(todayStr)) })
      .get()
    for (const item of items.data) {
      await db.collection('secondhand_items').doc(item._id).update({ data: { status: 'expired' } })
      expiredCount++
    }

    // 2. 转租：end_date（租期结束）过期的下架
    const sublets = await db.collection('sublet_items')
      .where({ status: 'on_sale', end_date: db.command.lt(todayStr) })
      .get()
    for (const s of sublets.data) {
      await db.collection('sublet_items').doc(s._id).update({ data: { status: 'expired' } })
      expiredCount++
    }

    // 3. 到期前一天提醒发帖人。
    //    放在下架之后跑：先把今天该下的下掉，再看明天该提醒谁，
    //    两批数据不会重叠。发不出去（没授权、票用完）一律忽略。
    const tomorrow = new Date(today.getTime() + 86400000)
    const tomorrowStr = tomorrow.getFullYear() + '-' +
      String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' +
      String(tomorrow.getDate()).padStart(2, '0')

    let notified = 0
    const SOON = [
      { collection: 'secondhand_items', dateField: 'expire_date', kind: '二手' },
      { collection: 'sublet_items', dateField: 'end_date', kind: '转租' }
    ]
    for (const cfg of SOON) {
      const where = { status: 'on_sale' }
      where[cfg.dateField] = tomorrowStr
      const soon = await db.collection(cfg.collection).where(where).limit(100).get()

      for (const post of soon.data) {
        if (!post._openid) continue
        try {
          await cloud.callFunction({
            name: 'sendSubscribe',
            data: {
              tpl: 'expiring',
              toUser: post._openid,
              page: 'pages/profile/profile',
              data: {
                title: post.title || '你发布的内容',
                kind: cfg.kind,
                expireAt: tomorrowStr,
                tip: '想继续展示，去「我的发布」改一下日期'
              }
            }
          })
          notified++
        } catch (e) {
          console.warn('到期提醒发送失败：', cfg.collection, post._id, e)
        }
      }
    }

    return { success: true, expiredCount: expiredCount, notified: notified }
  } catch (err) {
    return { success: false, error: err }
  }
}