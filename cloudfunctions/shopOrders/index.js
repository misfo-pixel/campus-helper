const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 店长侧的订单：拉列表 + 推进状态。
//
// 成团（forming → confirming）由 groupSettle 定时推进，之后全部由店长自己推进，
// 平台不介入——这就是「不需要管理员」的实现方式。
// 平台也不碰钱：订单里没有任何支付状态，小程序里也不展示收款方式。
// 「确认订单」只表示店长认了这一单；之前要不要先收钱，是他和买家在小程序外的事。

// 买家看到的时间按明尼苏达走，云函数机器的时区不可信
const TZ = 'America/Chicago'

function nowAt() {
  const parts = {}
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).forEach(p => {
    if (p.type !== 'literal') parts[p.type] = p.value
  })
  const hour = parts.hour === '24' ? '00' : parts.hour
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + hour + ':' + parts.minute
}

// 每个状态允许转到哪些状态。不在表里的转换一律拒绝，
// 免得前端出 bug 时把订单改成乱七八糟的状态。
const TRANSITIONS = {
  forming: ['cancelled'],                 // 拼团中 → 拒单（成团由 groupSettle 推进）
  confirming: ['accepted', 'cancelled'],  // 待确认 → 确认 / 取消
  pending: ['accepted', 'cancelled'],     // 改版前的老单：待确认 → 接单 / 拒单
  accepted: ['delivering', 'cancelled'],  // 准备中 → 开始配送 / 取消
  delivering: ['completed'],              // 配送中 → 已送达
  completed: [],
  cancelled: []
}

// 工作台四个 tab 各自对应哪些状态。老的 pending 单归到「待确认」
const TAB_STATUS = {
  forming: ['forming'],
  pending: ['confirming', 'pending'],
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
        const where = { shop_id: shop._id, status: _.in(statuses) }
        // 从场次卡片点「订单」进来的，只看这一场
        if (event.sessionId) where.session_id = String(event.sessionId)
        const res = await db.collection('shop_orders')
          .where(where)
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()
        return { success: true, orders: res.data }
      }

      // 工作台顶部那条今日数据
      case 'summary': {
        const start = new Date()
        start.setHours(0, 0, 0, 0)

        const todayRes = await db.collection('shop_orders')
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
            pendingCount: today.filter(o => o.status === 'confirming' || o.status === 'pending').length,
            revenue: Math.round(revenue * 100) / 100
          }
        }
      }

      case 'updateStatus': {
        const orderId = event.orderId
        const next = event.status
        if (!orderId || !next) return { success: false, message: '参数不完整' }

        const doc = await db.collection('shop_orders').doc(orderId).get()
        const order = doc.data
        if (!order || order.shop_id !== shop._id) {
          return { success: false, message: '没有权限' }
        }

        const allowed = TRANSITIONS[order.status] || []
        if (allowed.indexOf(next) === -1) {
          return { success: false, message: '这个订单已经不能改成该状态了' }
        }

        // 送达要带一张照片：拍在买家选的取货点。平台不碰钱也不派单，
        // 买家说「没收到」时，能拿出来的只有这张。照片由前端先传到云存储、过机检，这里只收 fileID
        const photo = typeof event.photo === 'string' ? event.photo.trim() : ''
        if (next === 'completed' && !/^cloud:\/\//.test(photo)) {
          return { success: false, message: '请先拍一张送达照片' }
        }

        // 送到后店长在取货点等多久（小店设置里改，默认 10 分钟），买家订单页显示「等到几点」
        const waitMinutes = shop.wait_minutes || 10
        const now = new Date()
        const waitUntil = new Date(now.getTime() + waitMinutes * 60000)

        // 带着旧状态做条件更新：截单那一刻 groupSettle 可能正在把这一单改成待确认
        const moved = await db.collection('shop_orders')
          .where({ _id: orderId, status: order.status })
          .update({
            data: {
              status: next,
              cancel_reason: next === 'cancelled' ? (event.reason || '店长取消') : '',
              ...(next === 'completed' ? { delivery_photo: photo, delivered_at: now, wait_until: waitUntil } : {}),
              updated_at: new Date()
            }
          })
        if (!moved.stats || moved.stats.updated !== 1) {
          return { success: false, message: '订单状态变了，刷新看看' }
        }

        // 只在送达时通知买家，用单独的「订单送达提醒」模板（买家下单时一起授权的）。
        // 订阅消息一张授权只能发一条，成团时的「待确认」用掉了订单进度通知那张，所以送达不能和它共用。
        // 模板里没有备注栏，「几分钟内取餐」放不进去，买家点开订单页能看到店长等到几点和照片
        if (next === 'completed') {
          try {
            await cloud.callFunction({
              name: 'sendSubscribe',
              data: {
                tpl: 'delivered',
                toUser: order.buyer,
                page: 'pages/myshoporders/myshoporders',
                data: {
                  shop: shop.name || '小店',
                  time: nowAt(),
                  phone: shop.contact_phone || '',
                  place: order.pickup_info || order.pickup_point || '取货点'
                }
              }
            })
          } catch (e) {
            console.warn('送达通知发送失败（不影响状态推进）：', e)
          }
        }

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
