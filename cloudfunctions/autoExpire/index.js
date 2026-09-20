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

    return { success: true, expiredCount: expiredCount }
  } catch (err) {
    return { success: false, error: err }
  }
}