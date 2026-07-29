const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV  // 自动使用当前云环境
})

const db = cloud.database()

// 云函数入口
exports.main = async (event, context) => {
  try {
    // 查询所有 status 为 pending_confirm（待确认）的订单
    const res = await db.collection('orders')
      .where({
        status: 'pending_confirm'
      })
      .orderBy('created_at', 'desc')
      .get()

    return {
      success: true,
      orders: res.data
    }
  } catch (err) {
    return {
      success: false,
      error: err
    }
  }
}