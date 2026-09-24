const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 买家侧读店铺、商品和配送方案。
//
// 走云函数而不是让小程序端直接查库，是因为 shops / shop_items 的集合权限
// 设成了「所有用户不可读写」——这样店长的联系方式这些字段就不会
// 被人绕过界面直接拖库。买家需要看到的字段在这里显式挑出来。

// 批次要按明尼苏达当地时间判断截没截单。这段和 deliveryManage / buyerOrders
// 里的是同一份——云函数之间没法共享代码，只能各存一份，改的时候三处一起改。
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

// 场次是「某一天的某个时间」，过了那天的截单时刻就不再展开——
// 买家看不到一个已经过去的场次，哪怕店长还没回来改。
//
// key 用 日期#送达时间：同一支配送队名下的店长天然共用一个 key，
// 配送队工作台按它分组，正好是「这一趟」。
//
// isToday / isTomorrow 给买家端拼文案用——场次可能在好几天后，
// 光靠「今天/明天」两个词表达不了。
function expandBatches(batches) {
  const now = nowInTZ()
  const tomorrow = addDays(now.date, 1)
  return (batches || []).map(b => {
    if (!b.date) return null
    const cutoffMin = toMinutes(b.cutoff)
    if (b.date < now.date) return null
    if (b.date === now.date && now.minutes >= cutoffMin) return null
    const isToday = b.date === now.date
    return {
      key: b.date + '#' + b.deliver_time,
      label: '',
      date: b.date,
      cutoff: b.cutoff,
      deliver_time: b.deliver_time,
      isToday: isToday,
      isTomorrow: b.date === tomorrow,
      minutesLeft: isToday ? cutoffMin - now.minutes : null
    }
  }).filter(Boolean)
}

// 配送方案一律是店铺自己那份。
//
// 以前这里会在「外包」时去读配送队的方案——那套已经撤了：队伍不再维护
// 自己的点位和班次，一律送到买家填的地址。这个函数于是退化成一次取值，
// 留着是因为调用方还想要 provider 这个字段。
function resolvePlan(shop) {
  return {
    pickup_points: shop.pickup_points || [],
    batches: shop.batches || [],
    provider: 'self',
    provider_name: shop.name || ''
  }
}

// 只列店长自己开着的店。被举报下架时 handleReport 会把 status 强制改成
// closed，所以这一条同时挡掉了下架的店，不需要再单独查 takedown。
async function listShops() {
  const res = await db.collection('shops')
    .where({ status: _.in(['open', 'paused']) })
    .limit(100)
    .get()

  // 营业中的排前面，同组内新店在前。店的数量不会多到需要在数据库里排。
  return res.data.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    return new Date(b.created_at) - new Date(a.created_at)
  })
}

exports.main = async (event) => {
  const action = event.action

  try {
    switch (action) {

      case 'list': {
        const shops = await listShops()
        return {
          success: true,
          shops: shops.map(s => ({
            _id: s._id,
            name: s.name,
            logo: s.logo,
            description: s.description,
            delivery_mode: s.delivery_mode || 'self',
            needs_delivery: s.needs_delivery !== false,
            min_order: s.min_order,
            business_hours: s.business_hours,
            status: s.status
          }))
        }
      }

      case 'detail': {
        if (!event.shopId) return { success: false, message: '缺少店铺 ID' }

        const doc = await db.collection('shops').doc(event.shopId).get()
        const shop = doc.data
        if (!shop || shop.status === 'closed') {
          return { success: false, message: '店铺不存在或已打烊' }
        }

        // 开团提醒的订阅状态顺手一起查，省买家一次跨太平洋往返。
        // shop_subscriptions 还没建（没人订阅过）时当 0 张票。
        const openid = cloud.getWXContext().OPENID
        const [itemsRes, subRes] = await Promise.all([
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
            : Promise.resolve({ data: [] })
        ])
        const sub = subRes.data[0]

        const plan = await resolvePlan(shop)

        return {
          success: true,
          plan: {
            pickup_points: plan.pickup_points,
            availableBatches: expandBatches(plan.batches),
            provider: plan.provider,
            provider_name: plan.provider_name
          },
          shop: {
            _id: shop._id,
            name: shop.name,
            logo: shop.logo,
            description: shop.description,
            delivery_mode: shop.delivery_mode || 'self',
            min_order: shop.min_order,
            business_hours: shop.business_hours,
            // 店长主动上传、同意公开展示的许可证（见《店长责任告知书》二）
            license_image: shop.license_image || '',
            use_category: shop.use_category === true,
            needs_delivery: shop.needs_delivery !== false,
            exact_address: shop.exact_address === true,
            flat_delivery_fee: Number(shop.flat_delivery_fee) || 0,
            contact_wechat: shop.contact_wechat,
            status: shop.status
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
            available: i.available !== false
          }))
        }
      }

      // 结算页只要方案，不需要整份商品列表
      case 'plan': {
        if (!event.shopId) return { success: false, message: '缺少店铺 ID' }
        const doc = await db.collection('shops').doc(event.shopId).get()
        const shop = doc.data
        if (!shop || shop.status === 'closed') {
          return { success: false, message: '店铺不存在' }
        }
        const plan = await resolvePlan(shop)
        return {
          success: true,
          // 纯线上服务没有方案，结算页据此整段隐藏地点和时间的选择
          needs_delivery: shop.needs_delivery !== false,
          // 送上门时买家填自己的地址，没有点位可选，配送费是一口价
          exact_address: shop.exact_address === true,
          flat_delivery_fee: Number(shop.flat_delivery_fee) || 0,
          // 下单时要不要买家补充说明，以及店长自己写的提示语
          note_required: shop.note_required === true,
          note_hint: shop.note_hint || '',
          pickup_points: plan.pickup_points,
          availableBatches: expandBatches(plan.batches),
          provider: plan.provider,
          provider_name: plan.provider_name
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
