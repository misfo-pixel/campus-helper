const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 买家侧订单：下单、看自己的单、取消。
//
// 配送模型：全部走服务时间，买家到服务地点自取（不送到公寓门口）。
// 服务地点和场次由实际送货的那一方定：店长自送就用店铺自己的，外包就用配送队的。
// 店长自己送和外包给配送队跑同一套规则，区别只在配送费最后归谁。
//
// 平台不经手资金，也不展示收款方式：订单只是买家的下单意向，
// 商品费和配送费怎么收由店长和买家自己在小程序外约定。
// 外包的话，那笔配送费算店长替配送队收的，事后按对账结果结给队伍。

// 用户在明尼苏达，场次截没截单必须按当地时间判断。
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


// 场次是「某一天的某个时间」，过了那天的截单时刻就不再展开。
// 这里必须和 shopBrowse 里那份保持一致：买家看到什么场次由那边算，
// 能不能下单由这边算，两边算法一旦错开就会出现「选得到但下不了」。
function expandBatches(batches) {
  const now = nowInTZ()
  return (batches || []).map(b => {
    if (!b.date) return null
    if (b.date < now.date) return null
    if (b.date === now.date && now.minutes >= toMinutes(b.cutoff)) return null
    return {
      key: b.date + '#' + b.deliver_time,
      label: '',
      date: b.date,
      cutoff: b.cutoff,
      deliver_time: b.deliver_time
    }
  }).filter(Boolean)
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
// 不然改一下请求就能一分钱买走整份商品列表。
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
    if (!doc) return { error: '有商品已经下架了，请重新选择' }
    if (doc.available === false) return { error: '「' + doc.name + '」已售罄，请重新选择' }

    const count = Math.floor(Number(raw.count))
    if (!(count > 0)) return { error: '商品数量不正确' }
    if (count > 50) return { error: '单个商品一次最多下 50 份' }

    // 存快照：店长之后改价、改单位或下架，历史订单还得是当时的样子
    items.push({
      item_id: doc._id, name: doc.name, price: doc.price,
      unit: doc.unit || '', count: count
    })
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
        if (!shop) {
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

        // ---- 配送：服务地点决定费率，场次决定什么时候送到 ----
        // 不送到公寓门口，买家到服务地点自取，所以不需要房间号。
        //
        // 不配送的店（顾客上门、到店自提）整段跳过：没有服务地点、没有场次、
        // 配送费为 0。订单只是一条「我要这些」的意向，怎么交付由双方自己约。
        const needsDelivery = shop.needs_delivery !== false

        let point = null
        let batch = null
        let outsourced = false

        if (needsDelivery) {
          const plan = await resolvePlan(shop)
          if (!plan.pickup_points.length || !plan.batches.length) {
            return { success: false, message: '这家店还没设置好服务地点或服务时间，暂时不能下单' }
          }

          const pointName = (event.pickup_point || '').trim()
          point = plan.pickup_points.find(p => p.name === pointName)
          if (!point) return { success: false, message: '请选择服务地点' }

          const available = expandBatches(plan.batches)
          if (!available.length) {
            // 店长设的那一场已经过去了，他还没回来开新的
            return { success: false, message: '这家店现在没有可约的服务时间，等店长开放新的服务时间再来' }
          }

          batch = available.find(b => b.key === event.batch_key)
          if (!batch) {
            // 前端页面开太久，选的那场已经截单了
            return { success: false, message: '这一场已经截单，请重新选择' }
          }

          // 用解析结果而不是 shop 上的字段：队伍被驳回时方案已经回落到自送，
          // 这时候再记一笔「欠队伍的钱」就对不上账了
          outsourced = plan.outsourced
        }

        const contactWechat = (event.contact_wechat || '').trim()
        if (!contactWechat) return { success: false, message: '请填写你的微信号' }

        const fee = point ? Math.round(point.fee * 100) / 100 : 0

        // charged 是买家实付，owed 是店长欠配送队的。
        // 现在两者相等；将来店长做「满 X 免配送费」时 charged 会变 0 而 owed 不变——
        // 配送队的钱不能因为店长搞活动就没了。对账永远按 owed 算。
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

            // 不配送的店这几项为空。delivery_status 仍然写 'waiting'：
            // delivery_team_id 是空的，配送队那边查不到这类单，状态机不受影响。
            needs_delivery: needsDelivery,
            pickup_point: point ? point.name : '',
            pickup_info: point ? point.name : '与店长自行约定',
            batch_key: batch ? batch.key : '',
            batch_label: batch ? batch.label : '',
            batch_date: batch ? batch.date : '',
            deliver_time: batch ? batch.deliver_time : '',

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

        // 通知店长有新订单。店长得自己在工作台授权过才收得到，
        // 发不出去是常态，绝不能让它影响下单本身。
        try {
          const first = built.items[0]
          const more = built.items.length > 1 ? ' 等 ' + built.items.length + ' 件' : ''
          const pad = n => (n < 10 ? '0' + n : '' + n)
          const now = new Date()
          await cloud.callFunction({
            name: 'sendSubscribe',
            data: {
              tpl: 'newOrder',
              toUser: shop.owner,
              page: 'pages/shopdashboard/shopdashboard',
              data: {
                buyer: nickname || '一位同学',
                orderType: '小店订单',
                content: first.name + '×' + first.count + more,
                amount: total,
                time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
              }
            }
          })
        } catch (e) {
          console.warn('新订单通知发送失败（不影响下单）：', e)
        }

        return {
          success: true,
          orderId: res._id,
          total: total,
          needs_delivery: needsDelivery,
          batch_label: batch ? batch.label : '',
          deliver_time: batch ? batch.deliver_time : '',
          batch_date: batch ? batch.date : '',
          contact_wechat: shop.contact_wechat
        }
      }

      case 'list': {
        const res = await db.collection('food_orders')
          .where({ buyer: openid })
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()

        // 每单带上店长微信，买家在订单里就能直接联系上店长
        const shopIds = [...new Set(res.data.map(o => o.shop_id))]
        const shopMap = {}
        if (shopIds.length > 0) {
          const shops = await db.collection('shops')
            .where({ _id: _.in(shopIds) }).limit(100).get()
          shops.data.forEach(s => {
            // 店长没开收款展示位就整块不下发，前端拿不到也就无从显示
            const on = s.payment_enabled === true
            shopMap[s._id] = {
              contact_wechat: s.contact_wechat,
              payment_enabled: on,
              payment_note: on ? (s.payment_note || '') : '',
              payment_qr: on ? (s.payment_qr || '') : ''
            }
          })
        }

        return {
          success: true,
          orders: res.data.map(o => {
            const s = shopMap[o.shop_id] || {}
            return Object.assign({}, o, {
              shop_wechat: s.contact_wechat || '',
              payment_enabled: s.payment_enabled === true,
              payment_note: s.payment_note || '',
              payment_qr: s.payment_qr || ''
            })
          })
        }
      }

      // 店长还没接单之前买家可以自己取消；接单之后就得直接找店长谈了，
      // 因为那时候店长可能已经开始准备了
      case 'cancel': {
        const doc = await db.collection('food_orders').doc(event.orderId).get()
        const order = doc.data
        if (!order || order.buyer !== openid) {
          return { success: false, message: '订单不存在' }
        }
        if (order.status !== 'pending') {
          return { success: false, message: '店长已经接单，请直接联系店长' }
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
