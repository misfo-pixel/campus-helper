const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 买家侧读店铺、菜单和配送方案。
//
// 走云函数而不是让小程序端直接查库，是因为 shops / shop_items 的集合权限
// 设成了「所有用户不可读写」——这样商家的收款方式、联系方式这些字段就不会
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
      deliver_time: b.deliver_time,
      isToday: isToday,
      minutesLeft: isToday ? cutoffMin - now.minutes : null
    }
  })
}

// 这家店的配送方案由谁提供：外包就用配送队的，否则用店铺自己的。
// 队伍如果被驳回或删了，退回店铺自己那份，免得订单彻底下不了。
async function resolvePlan(shop) {
  if (shop.delivery_mode === 'outsourced' && shop.delivery_team_id) {
    try {
      const t = await db.collection('delivery_teams').doc(shop.delivery_team_id).get()
      if (t.data && t.data.audit_status === 'approved') {
        return {
          pickup_points: t.data.pickup_points || [],
          batches: t.data.batches || [],
          provider: 'team',
          provider_name: t.data.name || ''
        }
      }
    } catch (e) {
      console.warn('读取配送队方案失败，回落到店铺自己的：', shop.delivery_team_id)
    }
  }
  return {
    pickup_points: shop.pickup_points || [],
    batches: shop.batches || [],
    provider: 'self',
    provider_name: shop.name || ''
  }
}

// 只有审核通过、且不是「打烊」状态的店才出现在列表里
async function listShops() {
  const res = await db.collection('shops')
    .where({ audit_status: 'approved', status: _.in(['open', 'paused']) })
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
            category: s.category,
            description: s.description,
            delivery_mode: s.delivery_mode || 'self',
            min_order: s.min_order,
            delivery_area: s.delivery_area,
            business_hours: s.business_hours,
            status: s.status
          }))
        }
      }

      case 'detail': {
        if (!event.shopId) return { success: false, message: '缺少店铺 ID' }

        const doc = await db.collection('shops').doc(event.shopId).get()
        const shop = doc.data
        if (!shop || shop.audit_status !== 'approved' || shop.status === 'closed') {
          return { success: false, message: '店铺不存在或已打烊' }
        }

        const itemsRes = await db.collection('shop_items')
          .where({ shop_id: shop._id })
          .orderBy('created_at', 'asc')
          .limit(200)
          .get()

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
            category: shop.category,
            description: shop.description,
            delivery_mode: shop.delivery_mode || 'self',
            min_order: shop.min_order,
            delivery_area: shop.delivery_area,
            business_hours: shop.business_hours,
            payment_note: shop.payment_note,     // 买家要按这个付款
            contact_wechat: shop.contact_wechat,
            status: shop.status
          },
          // 售罄的菜也返回，买家端灰掉展示，不然商家会被问「那道菜呢」
          items: itemsRes.data.map(i => ({
            _id: i._id,
            name: i.name,
            price: i.price,
            description: i.description,
            allergens: i.allergens || '',
            image: i.image,
            category: i.category,
            available: i.available !== false
          }))
        }
      }

      // 结算页只要方案，不需要整份菜单
      case 'plan': {
        if (!event.shopId) return { success: false, message: '缺少店铺 ID' }
        const doc = await db.collection('shops').doc(event.shopId).get()
        const shop = doc.data
        if (!shop || shop.audit_status !== 'approved') {
          return { success: false, message: '店铺不存在' }
        }
        const plan = await resolvePlan(shop)
        return {
          success: true,
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
