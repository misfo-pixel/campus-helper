const crypto = require('crypto')
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
//
// 2026-10-16 起网页店长后台（minne-web 的 /shop）也调这里，经 HTTP 访问服务，做法和 shopManage 一样：
// 请求头 x-web-key 要等于环境变量 WEB_KEY，身份是网页登录凭证换出来的店长（凭证由 shopManage 发）。
// 网页只开放 list 和 updateStatus，状态推进的规则、给买家的通知和小程序里是同一份。

// 每个状态允许转到哪些状态。不在表里的转换一律拒绝，
// 免得前端出 bug 时把订单改成乱七八糟的状态。
// 推给买家的状态词。模板里「当前状态」是 phrase 类型，5 个汉字封顶。
const STATUS_TEXT = {
  accepted: '已确认',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消'
}

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
  done: ['completed', 'cancelled'],
  // 网页导出 CSV、复制邮箱用：一场里的所有单
  all: ['forming', 'confirming', 'pending', 'accepted', 'delivering', 'completed', 'cancelled']
}

async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

// ---- 网页 ----

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex')

// 网页登录凭证 → 店长 openid。和 shopManage 的 webOwner 是同一份，改的时候两处一起改
async function webOwner(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null
  const res = await db.collection('web_sessions')
    .where({ token_hash: sha256(token), revoked: false, expires_at: _.gt(Date.now()) })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))   // 还没人用过网页登录时集合不存在
  return res.data[0] ? res.data[0].owner : null
}

function reply(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data)
  }
}

function headerOf(event, name) {
  const headers = (event && event.headers) || {}
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : ''
}

function bodyOf(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body
    return JSON.parse(raw || '{}')
  } catch (e) {
    return {}
  }
}

// 买家配图 cloud:// 换成临时链接，网页上才看得到。一次最多 50 个
async function noteImageUrls(orders) {
  const ids = []
  orders.forEach(o => (o.note_images || []).forEach(f => {
    if (typeof f === 'string' && f.indexOf('cloud://') === 0 && ids.indexOf(f) === -1) ids.push(f)
  }))
  const out = {}
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids.slice(i, i + 50).map(id => ({ fileID: id, maxAge: 3600 })) })
      res.fileList.forEach(f => { if (f.tempFileURL) out[f.fileID] = f.tempFileURL })
    } catch (e) {
      console.warn('换临时链接失败（不影响结果）：', e)
    }
  }
  return out
}

exports.main = async (event) => {
  if (event && event.httpMethod) {
    try {
      const key = process.env.WEB_KEY
      if (!key || headerOf(event, 'x-web-key') !== key) return reply(403, { success: false, message: 'forbidden' })
      const p = bodyOf(event)
      const owner = await webOwner(p.token)
      if (!owner) return reply(401, { success: false, message: '登录已失效，请重新登录' })
      if (['list', 'updateStatus'].indexOf(p.action) === -1) return reply(400, { success: false, message: '网页上不能做这个操作' })
      delete p.token
      return reply(200, await handle(p, owner, true))
    } catch (err) {
      console.error('shopOrders 网页请求失败：', err)
      return reply(500, { success: false, message: '服务出错了' })
    }
  }
  return handle(event || {}, cloud.getWXContext().OPENID, false)
}

// fromWeb 为 true 时是网页店长后台来的，openid 是登录凭证换出来的店长
async function handle(event, openid, fromWeb) {
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
        // 网页看一整场（复制邮箱、导出 CSV）要拿全，一场的单不会上几百
        const res = await db.collection('shop_orders')
          .where(where)
          .orderBy('created_at', 'desc')
          .limit(fromWeb && event.sessionId ? 500 : 50)
          .get()
        if (!fromWeb) return { success: true, orders: res.data }
        const urls = await noteImageUrls(res.data)
        return {
          success: true,
          orders: res.data.map(o => Object.assign({}, o, {
            buyer: undefined,
            note_image_urls: (o.note_images || []).map(f => urls[f]).filter(Boolean)
          }))
        }
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

        // 带着旧状态做条件更新：截单那一刻 groupSettle 可能正在把这一单改成待确认
        const moved = await db.collection('shop_orders')
          .where({ _id: orderId, status: order.status })
          .update({
            data: {
              status: next,
              cancel_reason: next === 'cancelled' ? (event.reason || '店长取消') : '',
              updated_at: new Date()
            }
          })
        if (!moved.stats || moved.stats.updated !== 1) {
          return { success: false, message: '订单状态变了，刷新看看' }
        }

        // 告诉买家状态变了。买家在下单那一刻授权过，这条多半发得出去。
        try {
          const first = (order.items || [])[0] || {}
          const more = (order.items || []).length > 1
            ? ' 等 ' + order.items.length + ' 件' : ''
          const pad = n => (n < 10 ? '0' + n : '' + n)
          const now = new Date()
          await cloud.callFunction({
            name: 'sendSubscribe',
            data: {
              tpl: 'orderProgress',
              toUser: order.buyer,
              page: 'pages/myshoporders/myshoporders',
              data: {
                status: STATUS_TEXT[next] || next,
                item: (first.name || '你的订单') + more,
                // date 类型：年月日，可带时分秒
                time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':00',
                tip: next === 'cancelled'
                  ? (event.reason || '店长取消了这笔订单')
                  : (shop.contact_phone ? '店长手机：' + shop.contact_phone : '店长联系方式见订单页')
              }
            }
          })
        } catch (e) {
          console.warn('订单进度通知发送失败（不影响状态推进）：', e)
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
