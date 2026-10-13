const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 买家侧读「一起拼团」：列表、店铺、下单页要的场次和取货点。
//
// 走云函数而不是让小程序端直接查库，是因为 shops / shop_items / shop_sessions
// 的集合权限设成了「所有用户不可读写」——这样店长的联系方式这些字段就不会
// 被人绕过界面直接拖库。买家需要看到的字段在这里显式挑出来。
//
// 买家能下单的场次 = state 为 open 且还没到截单时间（cutoff_at）。
// 截单之后这一场就从列表上消失，只在下过单的人的「我的订单」里看得到。

// 场次时间一律是明尼苏达当地时间的 'YYYY-MM-DD HH:MM' 字符串，直接按字符串比大小。
// 这段和 groupSettle / shopManage / buyerOrders 里的是同一份——
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

function minutesBetween(from, to) {
  const a = new Date(from.replace(' ', 'T') + ':00Z')
  const b = new Date(to.replace(' ', 'T') + ':00Z')
  return Math.round((b - a) / 60000)
}

// '12:00' + 15 → '12:15'，封顶 23:59。和小程序端 utils/date.js 的 addMinutes 是同一份
function addMinutes(hhmm, minutes) {
  const bits = String(hhmm).split(':')
  const total = Math.min(23 * 60 + 59, Number(bits[0]) * 60 + Number(bits[1]) + (Number(minutes) || 0))
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
}

// 每一场有几单（取消的不算）
async function countBySession(ids) {
  const out = {}
  ids.forEach(id => { out[id] = 0 })
  if (!ids.length) return out
  const $ = db.command.aggregate
  const res = await db.collection('shop_orders').aggregate()
    .match({ session_id: _.in(ids), status: _.neq('cancelled') })
    .group({ _id: '$session_id', n: $.sum(1) })
    .end()
  res.list.forEach(r => { out[r._id] = r.n })
  return out
}

// 买家看得到的一场。points 带上费用和约几点到，下单页直接用
function publicSession(s, count, now) {
  return {
    _id: s._id,
    shop_id: s.shop_id,
    shop_name: s.shop_name,
    date: s.date,
    depart_time: s.depart_time,
    cutoff_at: s.cutoff_at,
    confirm_at: s.confirm_at,
    minutes_left: minutesBetween(now, s.cutoff_at),
    min_orders: s.min_orders || 0,
    count: count || 0,
    repeat_weekly: s.repeat_weekly === true,
    points: (s.points || []).map(p => ({
      name: p.name,
      fee: Number(p.fee) || 0,
      arrive: addMinutes(s.depart_time, p.eta_minutes)
    }))
  }
}

// 能下单的场次。shop_sessions 还没建（没人开过团）时当没有
async function openSessions(where, now) {
  const res = await db.collection('shop_sessions')
    .where(Object.assign({ state: 'open', cutoff_at: _.gt(now) }, where))
    .orderBy('depart_at', 'asc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }))
  const counts = await countBySession(res.data.map(s => s._id))
  return res.data.map(s => publicSession(s, counts[s._id], now))
}

// 被举报下架的店不列。takedown 没这个字段的老店 neq(true) 也算
async function listShops() {
  const res = await db.collection('shops')
    .where({ takedown: _.neq(true) })
    .orderBy('created_at', 'desc')
    .limit(100)
    .get()
  return res.data
}

// 每道菜卖了几份（没取消的单）。转发卡片上的拍立得放卖得最多的那道
async function soldCounts(shopId) {
  const $ = db.command.aggregate
  try {
    const res = await db.collection('shop_orders').aggregate()
      .match({ shop_id: shopId, status: _.neq('cancelled') })
      .unwind('$items')
      .group({ _id: '$items.item_id', n: $.sum('$items.count') })
      .end()
    const out = {}
    res.list.forEach(r => { out[r._id] = r.n })
    return out
  } catch (e) {
    return {}
  }
}

async function getShop(shopId) {
  try {
    const shop = (await db.collection('shops').doc(shopId).get()).data
    return shop && !shop.takedown ? shop : null
  } catch (e) {
    return null
  }
}

// 列表顶上「我的拼团」：我还在拼团中、待确认的单，带上所在那一场的进度
async function myGroupOrders(openid, now) {
  if (!openid) return []
  const res = await db.collection('shop_orders')
    .where({ buyer: openid, status: _.in(['forming', 'confirming']) })
    .orderBy('created_at', 'desc')
    .limit(10)
    .get()
  const ids = [...new Set(res.data.map(o => o.session_id).filter(Boolean))]
  if (!ids.length) return []
  const sessions = await db.collection('shop_sessions').where({ _id: _.in(ids) }).limit(ids.length).get()
    .catch(() => ({ data: [] }))
  const counts = await countBySession(ids)
  const byId = {}
  sessions.data.forEach(s => { byId[s._id] = publicSession(s, counts[s._id], now) })
  return res.data
    .filter(o => byId[o.session_id])
    .map(o => ({
      _id: o._id,
      status: o.status,
      shop_id: o.shop_id,
      shop_name: o.shop_name,
      confirm_at: o.confirm_at,
      session: byId[o.session_id]
    }))
}

exports.main = async (event) => {
  const action = event.action
  const openid = cloud.getWXContext().OPENID
  const now = nowAt()

  try {
    switch (action) {

      // 列表页一次拿齐：所有能下单的场次、没场次的店、我的拼团
      case 'list': {
        const [shops, sessions, mine] = await Promise.all([
          listShops(),
          openSessions({}, now),
          myGroupOrders(openid, now)
        ])
        const byShop = {}
        shops.forEach(s => { byShop[s._id] = s })
        const live = sessions.filter(s => byShop[s.shop_id])
        const busy = new Set(live.map(s => s.shop_id))

        // 「我的拼团」转发时要画卡片，带上店铺的 logo 和广告语
        mine.forEach(o => {
          const shop = byShop[o.shop_id] || {}
          if (shop.name) o.shop_name = shop.name
          o.logo = shop.logo || ''
          o.slogan = shop.slogan || ''
          o.poster_style = shop.poster_style || 'magazine'
        })

        return {
          success: true,
          now: now,
          // 店名、logo、广告语一律读店铺上现在的，不用场次上存的那份
          sessions: live.map(s => Object.assign(s, {
            shop_name: byShop[s.shop_id].name,
            logo: byShop[s.shop_id].logo || '',
            slogan: byShop[s.shop_id].slogan || ''
          })),
          // 眼下没场次的店，折叠在列表最底下
          shops: shops.filter(s => !busy.has(s._id)).map(s => ({
            _id: s._id,
            name: s.name,
            logo: s.logo,
            description: s.description
          })),
          mine: mine
        }
      }

      case 'detail': {
        // 扫海报上的小程序码进来只带场次 ID（scene 最多 32 个字符，放不下两个 ID），反查是哪家店
        let shopId = event.shopId
        if (!shopId && event.sessionId) {
          try {
            shopId = (await db.collection('shop_sessions').doc(String(event.sessionId)).get()).data.shop_id
          } catch (e) {
            shopId = ''
          }
        }
        if (!shopId) return { success: false, message: '缺少店铺 ID' }
        const shop = await getShop(shopId)
        if (!shop) return { success: false, message: '店铺不存在' }

        // 开团提醒的订阅状态顺手一起查，省买家一次跨太平洋往返。
        // shop_subscriptions 还没建（没人订阅过）时当 0 张票。
        const [itemsRes, subRes, sessions, sold] = await Promise.all([
          db.collection('shop_items')
            .where({ shop_id: shop._id })
            .orderBy('created_at', 'asc')
            .limit(200)
            .get(),
          openid
            ? db.collection('shop_subscriptions')
              .where({ shop_id: shop._id, user: openid })
              .field({ tickets: true })
              .limit(1)
              .get()
              .catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] }),
          openSessions({ shop_id: shop._id }, now),
          soldCounts(shop._id)
        ])
        const sub = subRes.data[0]

        return {
          success: true,
          now: now,
          sessions: sessions,
          shop: {
            _id: shop._id,
            name: shop.name,
            logo: shop.logo,
            description: shop.description,
            slogan: shop.slogan || '',
            // 海报风格（店长在海报页挑的），转发卡片和店铺页跟着用
            poster_style: shop.poster_style || 'magazine',
            min_order: shop.min_order,
            // 店长主动上传、同意公开展示的许可证（见《店长责任告知书》二）
            license_image: shop.license_image || '',
            use_category: shop.use_category === true,
            needs_delivery: shop.needs_delivery !== false,
            contact_wechat: shop.contact_wechat
          },
          // 开团提醒：我还攒着几张票；店长看自己的店时不显示订阅按钮
          subscription: {
            tickets: (sub && sub.tickets) || 0,
            isMine: !!openid && shop.owner === openid
          },
          // 售罄的商品也返回，买家端灰掉展示，不然店长会被问「那件呢」
          items: itemsRes.data.map(i => ({
            _id: i._id,
            name: i.name,
            price: i.price,
            unit: i.unit || '',
            description: i.description,
            specs: i.specs || '',
            image: i.image,
            category: i.category,
            available: i.available !== false,
            sold: sold[i._id] || 0
          }))
        }
      }

      // 下单页：选中的那一场（取货点、费用、几点到）+ 店铺的下单设置
      case 'plan': {
        const shop = await getShop(event.shopId)
        if (!shop) return { success: false, message: '店铺不存在' }
        const sessions = await openSessions({ shop_id: shop._id }, now)
        const session = sessions.find(s => s._id === event.sessionId) || null
        return {
          success: true,
          session: session,
          // 送上门时买家填自己的地址，没有点位可选，配送费是一口价
          exact_address: shop.exact_address === true,
          flat_delivery_fee: Number(shop.flat_delivery_fee) || 0,
          // 下单时要不要买家补充说明，以及店长自己写的提示语
          note_required: shop.note_required === true,
          note_hint: shop.note_hint || ''
        }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('shopBrowse 失败：', action, err)
    return { success: false, message: '读取失败，请重试' }
  }
}
