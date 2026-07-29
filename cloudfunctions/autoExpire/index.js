const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    // 今天的日期，格式 YYYY-MM-DD（和 expire_date 存的格式一致）
    const today = new Date()
    const todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0')

    // 查所有在售、且下架日期小于今天的商品
    const res = await db.collection('secondhand_items')
      .where({
        status: 'on_sale',
        expire_date: db.command.lt(todayStr)   // lt = less than，小于今天
      })
      .get()

    console.log('过期商品数量：', res.data.length)

    // 逐个改成 expired
    for (const item of res.data) {
      await db.collection('secondhand_items').doc(item._id).update({
        data: { status: 'expired' }
      })
    }

    return { success: true, expiredCount: res.data.length }
  } catch (err) {
    return { success: false, error: err }
  }
}