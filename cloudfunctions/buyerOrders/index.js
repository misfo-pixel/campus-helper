const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 一起拼团（原校外服务）的形态。和小程序端 miniprogram/config.js 的 SHOP_MODE 是一对，
// 两边必须一致——那边管界面（黄页模式下根本不渲染购物车），这边是真闸门：
// 界面拦得住手滑，拦不住有人直接调云函数。
//
//   'catalog' 黄页 —— 拒绝一切建单请求。平台只展示信息，不撮合交易。
//   'order'   订单 —— 完整下单流程。
//
// ⚠️ 改这个值要连着改 config.js，并重新部署本函数。
const SHOP_MODE = 'order'

// 买家侧订单：下单、看自己的单、取消。
//
// 2026-10-11 起是「一起拼团」：每一单都挂在店长开的某一场（shop_sessions）上。
//   forming    拼团中。截单前随时能取消，不算什么
//   confirming 成团了，对外叫「待确认」：买家在 confirm_at 前联系店长，店长点「确认订单」
//   accepted   已确认，之后和以前一样：配送中 → 已完成
//   cancelled  没成团、超时没确认、买家或店长取消
// 状态推进在 groupSettle（定时）和 shopOrders（店长）里，这里只建单和取消。
//
// 配送模型：买家到取货点自取（不送到公寓门口）。取货点和费用是那一场的快照。
//
// 平台不经手资金，也不展示收款方式（《店长责任告知书》第六节）：
// 订单只是买家的下单意向，怎么付钱由店长和买家自己在小程序外约定。

// 场次时间一律是明尼苏达当地时间的 'YYYY-MM-DD HH:MM' 字符串，直接按字符串比大小。
// 这段和 groupSettle / shopManage / shopBrowse 里的是同一份——
// 云函数之间没法共享代码，只能各存一份，改的时候几处一起改。
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

// '12:00' + 15 → '12:15'，封顶 23:59。和小程序端 utils/date.js 的 addMinutes 是同一份
function addMinutes(hhmm, minutes) {
  const bits = String(hhmm).split(':')
  const total = Math.min(23 * 60 + 59, Number(bits[0]) * 60 + Number(bits[1]) + (Number(minutes) || 0))
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
}

// 爽约：成团后自己取消、或者超时没确认。30 天里满 2 次就暂时不能参团
const NO_SHOW_LIMIT = 2
const NO_SHOW_DAYS = 30

async function countSession(sessionId) {
  const res = await db.collection('shop_orders')
    .where({ session_id: sessionId, status: _.neq('cancelled') })
    .count()
  return res.total
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

// 不猜是美国号还是国内号：11 位以 1 开头的两边都有（1-763-… 和 137…），
// 猜错了反而拨不通。只要 10~15 位数字就收，按买家输入的样子存
function normalizePhone(raw) {
  const text = String(raw || '').trim().slice(0, 30)
  const digits = text.replace(/\D/g, '')
  return (digits.length >= 10 && digits.length <= 15) ? text : ''
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    switch (action) {

      case 'create': {
        // 黄页模式下平台不产生订单——这是类目合规的底线，放在最前面
        if (SHOP_MODE !== 'order') {
          return { success: false, message: '这家店通过微信直接联系下单' }
        }

        const shopDoc = await db.collection('shops').doc(event.shopId).get()
        const shop = shopDoc.data
        if (!shop || shop.takedown) {
          return { success: false, message: '店铺不存在' }
        }

        // 旧版小程序传的是 batch_key，没有场次可挂
        if (!event.session_id) return { success: false, message: '小程序有更新，请退出后重新打开再下单' }
        let session = null
        try {
          session = (await db.collection('shop_sessions').doc(String(event.session_id)).get()).data
        } catch (e) {
          session = null
        }
        if (!session || session.shop_id !== shop._id) return { success: false, message: '这一场不存在' }
        if (session.state !== 'open' || session.cutoff_at <= nowAt()) {
          return { success: false, message: '这一场已经截单了' }
        }

        const strikes = await db.collection('shop_orders')
          .where({
            buyer: openid,
            no_show: true,
            no_show_at: _.gte(new Date(Date.now() - NO_SHOW_DAYS * 24 * 3600 * 1000))
          })
          .count()
        if (strikes.total >= NO_SHOW_LIMIT) {
          return { success: false, message: '最近 ' + NO_SHOW_LIMIT + ' 次成团后没确认，暂时不能参团' }
        }

        const built = await buildOrderItems(shop._id, event.items)
        if (built.error) return { success: false, message: built.error }

        const minOrder = Number(shop.min_order) || 0
        if (built.subtotal < minOrder) {
          return { success: false, message: '还没到起送价 $' + minOrder }
        }

        // 店长要求补充说明的话，服务端也拦一道——前端那条只挡手滑。
        if (shop.note_required === true && !String(event.note || '').trim()) {
          return { success: false, message: '这家店要求填写补充说明' }
        }

        // ---- 配送：取货点决定费率和几点到，都是这一场的快照 ----
        const needsDelivery = true
        const exactAddress = shop.exact_address === true

        let point = null
        let address = ''
        let building = null
        let unlisted = ''      // 名单外手填的地址
        let unit = ''
        let phone = ''
        let fee = 0

        if (exactAddress) {
          // 送到买家地址：从楼栋名单里挑楼（见 buildings 云函数），再填房间号。
          // 名单外的选「其他」手填（building_id: 'other'），订单上标 address_unlisted，
          // 店长自己判断送不送得到；下单成功后再写一条意见反馈，管理员核实后加进名单。
          if (!event.building_id) return { success: false, message: '请选择楼栋' }
          unit = String(event.unit || '').trim().slice(0, 40)
          if (!unit) return { success: false, message: '请填写房间号' }

          if (event.building_id === 'other') {
            unlisted = String(event.other_address || '').trim().slice(0, 100)
            if (unlisted.length < 4) return { success: false, message: '请填写完整的地址' }
            address = unlisted + ', ' + unit
          } else {
            try {
              building = (await db.collection('delivery_buildings').doc(event.building_id).get()).data
            } catch (e) {
              building = null
            }
            if (!building || !building.active) return { success: false, message: '这栋楼不在配送范围内，请重新选择' }
            address = building.name + ', ' + unit
          }
          fee = Math.round((Number(shop.flat_delivery_fee) || 0) * 100) / 100
        } else {
          const pointName = (event.pickup_point || '').trim()
          point = (session.points || []).find(p => p.name === pointName)
          if (!point) return { success: false, message: '请选择取货点' }
          fee = Math.round((Number(point.fee) || 0) * 100) / 100
        }

        // 2026-10-13 起下单要先验证邮箱，订单上的联系邮箱取验证过的那个（user_emails，见 emailVerify），
        // 前端传什么都不信。还没更新的旧版前端只会传 contact_wechat，过渡期照收，
        // 不然它们下不了单；等旧版本没人用了再把这个分支删掉
        const contactWechat = String(event.contact_wechat || '').trim()
        let contactEmail = ''
        if (!contactWechat) {
          try {
            contactEmail = (await db.collection('user_emails').doc(openid).get()).data.email || ''
          } catch (e) { /* 没验证过，下面拦 */ }
          if (!contactEmail) return { success: false, message: '请先在资料页验证邮箱' }
        }

        // 线下交付的单要手机号：找不到楼、送到了没人应、邮件没回，都得能打通电话
        phone = normalizePhone(event.phone)
        if (!phone) return { success: false, message: '请填写正确的手机号' }

        // 配送费全归店长。配送队那条线现在是店长和队长私下谈钱，
        // 平台不再记「店长欠队伍多少」——对账模块已经不接入了。
        const feeCharged = fee
        const feeOwed = 0

        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取买家昵称失败，留空：', e)
        }

        const total = Math.round((built.subtotal + feeCharged) * 100) / 100

        // 这一单预计几点到：取货点 = 出发时间 + 这个点的分钟数；送上门估不了，就写出发时间
        const deliverTime = point ? addMinutes(session.depart_time, point.eta_minutes) : session.depart_time

        const res = await db.collection('shop_orders').add({
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
            exact_address: exactAddress,
            address: address,
            // 楼栋快照：楼名以后改了，这一单还是下单时那个名字
            building_id: building ? building._id : '',
            building_name: building ? building.name : '',
            address_unlisted: !!unlisted,
            unit: unit,
            phone: phone,
            pickup_point: point ? point.name : '',
            // 工作台和订单列表直接显示这一行：送上门显示地址，自取显示点位
            pickup_info: exactAddress ? address : point.name,

            // 挂在哪一场。截单、确认截止抄一份到单上，groupSettle 直接按单查，不用先查场次
            session_id: session._id,
            cutoff_at: session.cutoff_at,
            confirm_at: session.confirm_at,
            // 下面这几项老代码（工作台、找配送队）还在读，照旧写
            batch_key: session._id,
            batch_label: '',
            batch_date: session.date,
            depart_time: session.depart_time,
            deliver_time: deliverTime,
            // 从转发卡片点进来下的单记 'share'，扫海报上的码进来的记 'poster'，看各自拉来了多少单
            source: ['share', 'poster'].indexOf(event.source) !== -1 ? event.source : '',

            delivery_mode: shop.delivery_mode || 'self',
            delivery_team_id: '',
            delivery_fee_charged: feeCharged,
            delivery_fee_owed: feeOwed,
            deliverer: '',
            delivery_status: 'waiting',   // waiting → picked → delivered
            settled: false,

            total: total,
            contact_email: contactEmail,
            contact_wechat: contactWechat,
            note: (event.note || '').trim().slice(0, 200),
            // 买家自己传的配图（尺寸、款式、参考图）。前端限 3 张，这里再兜一次
            note_images: Array.isArray(event.note_images)
              ? event.note_images.filter(x => typeof x === 'string' && x).slice(0, 3)
              : [],
            status: 'forming',
            cancel_reason: '',
            created_at: new Date(),
            updated_at: new Date()
          }
        })

        // 名单外地址：替买家写一条意见反馈，管理员在「意见反馈」里就能看到，
        // 核实后去「配送楼栋」加进名单。买家不用自己再去反馈页填一遍。
        // 同一个地址已经有一条没处理的就不重复写。写不进去不影响下单。
        if (unlisted) {
          try {
            const content = '下单时填了名单外的地址：' + unlisted + '（小店：' + shop.name + '）。核实在范围内的话，去「配送楼栋」加进名单。'
            const key = unlisted.toLowerCase().replace(/\s+/g, ' ')
            const dup = await db.collection('feedback').where({
              type: '楼栋补录',
              unlisted_key: key,
              replied: db.command.neq(true)
            }).count()
            if (!dup.total) {
              await db.collection('feedback').add({
                data: {
                  _openid: openid,   // 归属给买家，管理员回复时通知的是他
                  type: '楼栋补录',
                  content: content,
                  contact: contactEmail || contactWechat,
                  unlisted_key: key,
                  createTime: db.serverDate()
                }
              })
            }
          } catch (e) {
            console.warn('楼栋补录反馈写入失败（不影响下单）：', e)
          }
        }

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

        // 参团成功页要显示「再来几位就开团」，把这一场下单后的单数带回去
        let count = 0
        try {
          count = await countSession(session._id)
        } catch (e) {
          console.warn('数单数失败：', e)
        }

        return {
          success: true,
          orderId: res._id,
          total: total,
          session_id: session._id,
          count: count,
          min_orders: session.min_orders || 0,
          cutoff_at: session.cutoff_at,
          date: session.date,
          deliver_time: deliverTime,
          pickup_point: point ? point.name : ''
        }
      }

      case 'list': {
        const res = await db.collection('shop_orders')
          .where({ buyer: openid })
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()

        // 每单带上店长手机，买家在订单里有急事能直接打过去
        const shopIds = [...new Set(res.data.map(o => o.shop_id))]
        const shopMap = {}
        if (shopIds.length > 0) {
          const shops = await db.collection('shops')
            .where({ _id: _.in(shopIds) }).limit(100).get()
          shops.data.forEach(s => {
            // logo、广告语给「喊人上车」画转发卡片用
            shopMap[s._id] = { name: s.name, contact_phone: s.contact_phone, contact_wechat: s.contact_wechat, logo: s.logo || '', slogan: s.slogan || '', poster_style: s.poster_style || 'magazine' }
          })
        }

        // 还在拼团中的单带上所在那一场的进度（几单、门槛），卡片上画进度条
        const forming = [...new Set(res.data.filter(o => o.status === 'forming').map(o => o.session_id))]
        const progress = {}
        if (forming.length) {
          const sessions = await db.collection('shop_sessions').where({ _id: _.in(forming) }).limit(forming.length).get()
          const $ = db.command.aggregate
          const counts = await db.collection('shop_orders').aggregate()
            .match({ session_id: _.in(forming), status: _.neq('cancelled') })
            .group({ _id: '$session_id', n: $.sum(1) })
            .end()
          const n = {}
          counts.list.forEach(r => { n[r._id] = r.n })
          sessions.data.forEach(s => {
            progress[s._id] = {
              count: n[s._id] || 0,
              min_orders: s.min_orders || 0,
              depart_time: s.depart_time
            }
          })
        }

        return {
          success: true,
          now: nowAt(),
          orders: res.data.map(o => {
            const s = shopMap[o.shop_id] || {}
            // note / note_images 本来就在订单文档里，Object.assign 直接带过去
            return Object.assign({}, o, {
              // 店铺改过名就显示现在的名字；店删了才用下单时存的那个
              shop_name: s.name || o.shop_name,
              shop_phone: s.contact_phone || '',
              // 老店还没补手机号时的兜底
              shop_wechat: s.contact_phone ? '' : (s.contact_wechat || ''),
              shop_logo: s.logo || '',
              shop_slogan: s.slogan || '',
              shop_poster_style: s.poster_style || 'magazine',
              progress: progress[o.session_id] || null
            })
          })
        }
      }

      // 买家自己取消：
      //   拼团中 —— 随便取消
      //   待确认 —— 能取消，但店长可能已经按成团的单数备料了，记一次爽约
      //   店长确认之后 —— 得直接找店长谈了
      // pending 是改版前的老单，照旧能取消
      case 'cancel': {
        const doc = await db.collection('shop_orders').doc(event.orderId).get()
        const order = doc.data
        if (!order || order.buyer !== openid) {
          return { success: false, message: '订单不存在' }
        }
        if (['forming', 'confirming', 'pending'].indexOf(order.status) === -1) {
          return { success: false, message: '店长已确认，请直接联系店长' }
        }

        const strike = order.status === 'confirming'
        const res = await db.collection('shop_orders')
          .where({ _id: order._id, status: order.status })
          .update({
            data: Object.assign({
              status: 'cancelled',
              cancel_reason: '买家取消',
              updated_at: new Date()
            }, strike ? { no_show: true, no_show_at: new Date() } : {})
          })
        if (!res.stats || res.stats.updated !== 1) return { success: false, message: '订单状态变了，刷新看看' }
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
