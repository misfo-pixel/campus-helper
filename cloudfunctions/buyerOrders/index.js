const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 买家侧订单：下单、看自己的单、取消。
//
// 配送模型：全部走批次，买家到取餐点自取（不送到公寓门口）。
// 取餐点和批次由实际送货的那一方定：商家自送就用店铺自己的，外包就用配送队的。
// 商家自己送和外包给配送队跑同一套规则，区别只在配送费最后归谁。
//
// 平台不经手资金：买家一次性把「餐费 + 配送费」付给商家。
// 外包的话，那笔配送费是商家替配送队代收的，事后按对账结果结给队伍。

// 用户在明尼苏达，批次截没截单必须按当地时间判断。
// 这段逻辑和 deliveryManage 里的是同一份——云函数之间没法共享代码，只能各存一份。
const TZ = 'America/Chicago'

function nowInTZ() {
  const parts = {}
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).forEach(p => {
    if (p.type !== 'literal') parts[p.type] = p.value
  })
  let hour = Number(parts.hour)
  if (hour === 24) hour = 0
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    minutes: hour * 60 + Number(parts.minute)
  }
}

function toMinutes(hhmm) {
  const bits = String(hhmm).split(':')
  return Number(bits[0]) * 60 + Number(bits[1])
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function expandBatches(batches) {
  const now = nowInTZ()
  return (batches || []).map(b => {
    const cutoffMin = toMinutes(b.cutoff)
    const isToday = now.minutes < cutoffMin
    const date = isToday ? now.date : addDays(now.date, 1)
    return {
      key: date + '#' + b.label,
      label: b.label,
      date: date,
      cutoff: b.cutoff,
      deliver_time: b.deliver_time
    }
  })
}

// 这家店的配送方案归谁：外包用配送队的，否则用店铺自己的。
// 队伍被驳回或删了就退回店铺那份，免得订单彻底下不了。
async function resolvePlan(shop) {
  if (shop.delivery_mode === 'outsourced' && shop.delivery_team_id) {
    try {
      const t = await db.collection('delivery_teams').doc(shop.delivery_team_id).get()
      if (t.data && t.data.audit_status === 'approved') {
        return {
          pickup_points: t.data.pickup_points || [],
          batches: t.data.batches || [],
          outsourced: true
        }
      }
    } catch (e) {
      console.warn('读取配送队方案失败，回落到店铺自己的：', shop.delivery_team_id)
    }
  }
  return {
    pickup_points: shop.pickup_points || [],
    batches: shop.batches || [],
    outsourced: false
  }
}

// 金额一律用数据库里的当前价重算，绝不采信前端传来的价格和总价。
// 不然改一下请求就能一分钱买走整个菜单。
async function buildOrderItems(shopId, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: '购物车是空的' }
  }

  const ids = rawItems.map(i => i.item_id).filter(Boolean)
  if (ids.length === 0) return { error: '购物车数据不完整' }

  const res = await db.collection('shop_items')
    .where({ _id: _.in(ids), shop_id: shopId })
    .limit(200)
    .get()

  const byId = {}
  res.data.forEach(doc => { byId[doc._id] = doc })

  const items = []
  let subtotal = 0

  for (const raw of rawItems) {
    const doc = byId[raw.item_id]
    if (!doc) return { error: '有菜品已经下架了，请重新选择' }
    if (doc.available === false) return { error: '「' + doc.name + '」已售罄，请重新选择' }

    const count = Math.floor(Number(raw.count))
    if (!(count > 0)) return { error: '菜品数量不正确' }
    if (count > 50) return { error: '单个菜品一次最多下 50 份' }

    // 存快照：商家之后改价或下架，历史订单还得是当时的样子
    items.push({ item_id: doc._id, name: doc.name, price: doc.price, count: count })
    subtotal += doc.price * count
  }

  return { items: items, subtotal: Math.round(subtotal * 100) / 100 }
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    switch (action) {

      case 'create': {
        const shopDoc = await db.collection('shops').doc(event.shopId).get()
        const shop = shopDoc.data
        if (!shop || shop.audit_status !== 'approved') {
          return { success: false, message: '店铺不存在' }
        }
        if (shop.status !== 'open') {
          return { success: false, message: '店铺当前不接单' }
        }

        const built = await buildOrderItems(shop._id, event.items)
        if (built.error) return { success: false, message: built.error }

        const minOrder = Number(shop.min_order) || 0
        if (built.subtotal < minOrder) {
          return { success: false, message: '还没到起送价 $' + minOrder }
        }

        // ---- 配送：取餐点决定费率，批次决定什么时候到 ----
        // 不送到公寓门口，买家到点自取，所以不需要房间号
        const plan = await resolvePlan(shop)
        if (!plan.pickup_points.length || !plan.batches.length) {
          return { success: false, message: '这家店还没设置好取餐点或配送时间，暂时不能下单' }
        }

        const pointName = (event.pickup_point || '').trim()
        const point = plan.pickup_points.find(p => p.name === pointName)
        if (!point) return { success: false, message: '请选择取餐点' }

        const batch = expandBatches(plan.batches).find(b => b.key === event.batch_key)
        if (!batch) {
          // 前端页面开太久，选的那班已经截单了
          return { success: false, message: '这个配送场次已经截单，请重新选择' }
        }

        const contactWechat = (event.contact_wechat || '').trim()
        if (!contactWechat) return { success: false, message: '请填写你的微信号' }

        // 用解析结果而不是 shop 上的字段：队伍被驳回时方案已经回落到自送，
        // 这时候再记一笔「欠队伍的钱」就对不上账了
        const outsourced = plan.outsourced
        const fee = Math.round(point.fee * 100) / 100

        // charged 是买家实付，owed 是商家欠配送队的。
        // 现在两者相等；将来商家做「满 X 免配送费」时 charged 会变 0 而 owed 不变——
        // 配送队的钱不能因为商家搞活动就没了。对账永远按 owed 算。
        const feeCharged = fee
        const feeOwed = outsourced ? fee : 0

        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取买家昵称失败，留空：', e)
        }

        const total = Math.round((built.subtotal + feeCharged) * 100) / 100

        const res = await db.collection('food_orders').add({
          data: {
            shop_id: shop._id,
            shop_name: shop.name,
            buyer: openid,
            buyer_nickname: nickname,
            items: built.items,
            subtotal: built.subtotal,

            pickup_point: point.name,
            pickup_address: point.address || '',
            pickup_info: point.name,   // 商家工作台和订单列表直接显示这个
            batch_key: batch.key,
            batch_label: batch.label,
            batch_date: batch.date,
            deliver_time: batch.deliver_time,

            delivery_mode: outsourced ? 'outsourced' : 'self',
            delivery_team_id: outsourced ? shop.delivery_team_id : '',
            delivery_fee_charged: feeCharged,
            delivery_fee_owed: feeOwed,
            deliverer: '',
            delivery_status: 'waiting',   // waiting → picked → delivered
            settled: false,

            total: total,
            contact_wechat: contactWechat,
            note: (event.note || '').trim().slice(0, 200),
            status: 'pending',
            cancel_reason: '',
            created_at: new Date(),
            updated_at: new Date()
          }
        })

        return {
          success: true,
          orderId: res._id,
          total: total,
          batch_label: batch.label,
          deliver_time: batch.deliver_time,
          batch_date: batch.date,
          payment_note: shop.payment_note,
          contact_wechat: shop.contact_wechat
        }
      }

      case 'list': {
        const res = await db.collection('food_orders')
          .where({ buyer: openid })
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()

        // 每单带上商家的收款方式，买家在订单里就能看到该往哪转账
        const shopIds = [...new Set(res.data.map(o => o.shop_id))]
        const shopMap = {}
        if (shopIds.length > 0) {
          const shops = await db.collection('shops')
            .where({ _id: _.in(shopIds) }).limit(100).get()
          shops.data.forEach(s => {
            shopMap[s._id] = { payment_note: s.payment_note, contact_wechat: s.contact_wechat }
          })
        }

        return {
          success: true,
          orders: res.data.map(o => Object.assign({}, o, {
            payment_note: (shopMap[o.shop_id] || {}).payment_note || '',
            shop_wechat: (shopMap[o.shop_id] || {}).contact_wechat || ''
          }))
        }
      }

      // 商家还没接单之前买家可以自己取消；接单之后就得直接找商家谈了，
      // 因为那时候钱可能已经转过去、菜可能已经在做了
      case 'cancel': {
        const doc = await db.collection('food_orders').doc(event.orderId).get()
        const order = doc.data
        if (!order || order.buyer !== openid) {
          return { success: false, message: '订单不存在' }
        }
        if (order.status !== 'pending') {
          return { success: false, message: '商家已经接单，请直接联系商家' }
        }

        await db.collection('food_orders').doc(event.orderId).update({
          data: {
            status: 'cancelled',
            cancel_reason: '买家取消',
            updated_at: new Date()
          }
        })
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('buyerOrders 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
