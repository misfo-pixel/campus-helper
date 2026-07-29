const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    const res = await db.collection('orders')
      .where({ status: 'confirmed' })
      .orderBy('created_at', 'desc')
      .get()
    return { success: true, orders: res.data }
  } catch (err) {
    return { success: false, error: err }
  }
}