const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 商家侧的订单：拉列表 + 推进状态。
//
// 状态机全部由商家自己推进，平台不介入任何一步——这就是「不需要管理员」的实现方式。
// 平台也不碰钱：订单里没有任何支付状态，收款是商家在小程序外自己完成的，
// 商家确认收到钱之后才点「接单」。

// 每个状态允许转到哪些状态。不在表里的转换一律拒绝，
// 免得前端出 bug 时把订单改成乱七八糟的状态。
const TRANSITIONS = {
  pending: ['accepted', 'cancelled'],     // 待确认 → 接单 / 拒单
  accepted: ['delivering', 'cancelled'],  // 备餐中 → 开始配送 / 取消
  delivering: ['completed'],              // 配送中 → 已送达
  completed: [],
  cancelled: []
}

// 工作台三个 tab 各自对应哪些状态
const TAB_STATUS = {
  pending: ['pending'],
  active: ['accepted', 'delivering'],
  done: ['completed', 'cancelled']
}

async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    const shop = await getMyShop(openid)
    if (!shop) return { success: false, message: '你还没有店铺' }

    switch (action) {

      case 'list': {
        const statuses = TAB_STATUS[event.tab] || TAB_STATUS.pending
        const res = await db.collection('food_orders')
          .where({ shop_id: shop._id, status: _.in(statuses) })
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()
        return { success: true, orders: res.data }
      }

      // 工作台顶部那条今日数据
      case 'summary': {
        const start = new Date()
        start.setHours(0, 0, 0, 0)

        const todayRes = await db.collection('food_orders')
          .where({ shop_id: shop._id, created_at: _.gte(start) })
          .limit(500)
          .get()

        const today = todayRes.data
        // 流水只算没被取消的
        const revenue = today
          .filter(o => o.status !== 'cancelled')
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0)

        return {
          success: true,
          summary: {
            todayCount: today.length,
            pendingCount: today.filter(o => o.status === 'pending').length,
            revenue: Math.round(revenue * 100) / 100
          }
        }
      }

      case 'updateStatus': {
        const orderId = event.orderId
        const next = event.status
        if (!orderId || !next) return { success: false, message: '参数不完整' }

        const doc = await db.collection('food_orders').doc(orderId).get()
        const order = doc.data
        if (!order || order.shop_id !== shop._id) {
          return { success: false, message: '没有权限' }
        }

        const allowed = TRANSITIONS[order.status] || []
        if (allowed.indexOf(next) === -1) {
          return { success: false, message: '这个订单已经不能改成该状态了' }
        }

        await db.collection('food_orders').doc(orderId).update({
          data: {
            status: next,
            cancel_reason: next === 'cancelled' ? (event.reason || '') : '',
            updated_at: new Date()
          }
        })
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('shopOrders 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
