const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 校外服务的「开团提醒」：买家订阅一家店，店长每开一场就发一条微信通知。
//
// 先说清楚微信的限制，整套设计都是被它逼出来的：
//   订阅消息是【一次性】的——买家点一次「允许」只换来一张票，发一条就没了。
//   长期订阅只开放给政务、医疗、交通这类类目，我们拿不到。
// 所以「订阅」在这里的真实含义是「攒票」：
//   - 买家每点一次「订阅 / 再加一次」，tickets + 1（微信那边也同样累加）
//   - 每发出一条开团提醒，tickets - 1；票用完了店铺页上显示回「订阅」
//   - 微信回 43101（用户没票 / 关了通知）时直接清零，别再白发
//
// 数据在 shop_subscriptions：{ shop_id, user(openid), tickets, created_at, updated_at }。
// 集合权限要设成「所有用户不可读写」——里面是 openid，只有云函数能碰。
//
// 什么算「开团」：店在营业中，并且出现了一场买家约得上的新场次。
// 用 shops.last_announced 记住上一次通知的是哪一场，同一场只通知一次——
// 店长打烊再开门、改个商品再保存，都不会重复打扰人。
// 纯线上服务没有场次也没有截单时间，不算开团，不发（店铺页也不给它显示订阅条）。
// 模板是「产品截团通知」，截团时间是必填的 time 字段，硬凑一个时间只会误导人。

// 场次截没截单要按明尼苏达当地时间判断。这段和 shopManage / shopBrowse /
// buyerOrders / deliveryManage 里的是同一份——云函数之间没法共享代码，
// 只能各存一份，改的时候几处一起改。
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

// 这家店当前「开的是哪一团」。返回 null = 眼下没有能通知的场次。
function currentSession(shop) {
  if (shop.needs_delivery === false) return null

  const now = nowInTZ()
  const b = (shop.batches || [])[0]
  if (!b || !b.date) return null
  if (b.date < now.date) return null
  if (b.date === now.date && now.minutes >= toMinutes(b.cutoff)) return null

  return {
    key: b.date + '#' + b.cutoff + '#' + b.deliver_time,
    // time 类型字段要「2026-09-25 16:00」这种格式。明尼苏达当地时间，不换算
    cutoff: b.date + ' ' + b.cutoff,
    tip: '服务时间 ' + b.date.slice(5) + ' ' + b.deliver_time
  }
}

// shop_subscriptions 要在控制台手动建，漏建时第一次订阅就报 -502005。
// 每个实例自己建一次；已存在时 createCollection 报错，吞掉即可。
let collectionReady = false
async function ensureCollection() {
  if (collectionReady) return
  try {
    await db.createCollection('shop_subscriptions')
  } catch (e) { /* 已经存在 */ }
  collectionReady = true
}

async function getShop(shopId) {
  try {
    const res = await db.collection('shops').doc(shopId).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

async function mySubscription(shopId, openid) {
  const res = await db.collection('shop_subscriptions')
    .where({ shop_id: shopId, user: openid })
    .limit(1)
    .get()
  return res.data[0] || null
}

const PAGE = 100          // 一次捞多少个订阅者
const MAX_PAGES = 10      // 最多通知 1000 人，真到这个量级再改成分批触发

// 把一场开团通知发给这家店所有还有票的订阅者，并按结果扣票
async function fanOut(shop, session) {
  let sent = 0
  let failed = 0
  // 按 _id 游标翻页而不是 skip：发完就扣票，有人会从 tickets > 0 里掉出去，
  // 用 skip 的话后面的人会整体前移、被跳过
  let lastId = ''

  for (let page = 0; page < MAX_PAGES; page++) {
    const where = { shop_id: shop._id, tickets: _.gt(0) }
    if (lastId) where._id = _.gt(lastId)
    const res = await db.collection('shop_subscriptions')
      .where(where)
      .orderBy('_id', 'asc')
      .limit(PAGE)
      .field({ user: true })
      .get()
    if (!res.data.length) break
    lastId = res.data[res.data.length - 1]._id
    const users = res.data.map(s => s.user).filter(Boolean)

    const out = await cloud.callFunction({
      name: 'sendSubscribe',
      data: {
        tpl: 'shopOpen',
        toUsers: users,
        page: 'pages/shopdetail/shopdetail?id=' + shop._id,
        data: { shop: shop.name, cutoff: session.cutoff, tip: session.tip }
      }
    })
    const r = (out && out.result) || {}
    // 模板还没申请（pending）：一张票都没动，直接收工
    if (!r.results) return { sent: 0, failed: 0, pending: !!r.pending }

    const ok = r.results.filter(x => x.success).map(x => x.toUser)
    const gone = r.results.filter(x => !x.success && x.errCode === 43101).map(x => x.toUser)
    sent += ok.length
    failed += r.results.length - ok.length

    const writes = []
    if (ok.length) {
      writes.push(db.collection('shop_subscriptions')
        .where({ shop_id: shop._id, user: _.in(ok) })
        .update({ data: { tickets: _.inc(-1), updated_at: new Date() } }))
    }
    if (gone.length) {
      writes.push(db.collection('shop_subscriptions')
        .where({ shop_id: shop._id, user: _.in(gone) })
        .update({ data: { tickets: 0, updated_at: new Date() } }))
    }
    await Promise.all(writes)

    if (res.data.length < PAGE) break
  }

  return { sent: sent, failed: failed }
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    switch (action) {

      // 买家刚在授权弹窗里点了「允许」，给他记一张票
      case 'subscribe': {
        if (!openid) return { success: false, message: '请先登录' }
        const shop = await getShop(event.shopId)
        if (!shop || shop.status === 'closed') return { success: false, message: '店铺不存在或已打烊' }

        await ensureCollection()
        const existing = await mySubscription(shop._id, openid)
        if (existing) {
          await db.collection('shop_subscriptions').doc(existing._id).update({
            data: { tickets: _.inc(1), updated_at: new Date() }
          })
          return { success: true, tickets: (existing.tickets || 0) + 1 }
        }
        await db.collection('shop_subscriptions').add({
          data: {
            shop_id: shop._id,
            user: openid,
            tickets: 1,
            created_at: new Date(),
            updated_at: new Date()
          }
        })
        return { success: true, tickets: 1 }
      }

      // 取消只是不再发。微信那边攒下的票收不回来，也不需要收回
      case 'unsubscribe': {
        if (!openid) return { success: false, message: '请先登录' }
        await ensureCollection()
        await db.collection('shop_subscriptions')
          .where({ shop_id: String(event.shopId || ''), user: openid })
          .update({ data: { tickets: 0, updated_at: new Date() } })
        return { success: true, tickets: 0 }
      }

      // 店长开门营业、或保存了新场次之后，小程序端顺手调一次（不等结果）。
      // 幂等：没有新场次就什么都不做，所以多调几次也不会重复打扰人。
      // 只认调用者自己的店，别人没法替某家店「开团」去骚扰订阅者。
      case 'announce': {
        if (!openid) return { success: false, message: '请先登录' }
        const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
        const shop = res.data[0]
        if (!shop) return { success: false, message: '你还没有店铺' }
        if (shop.status !== 'open' || shop.takedown) return { success: true, announced: false }

        const session = currentSession(shop)
        if (!session || shop.last_announced === session.key) {
          return { success: true, announced: false }
        }

        // 先占位再发：两次 announce 前后脚进来（开门 + 保存设置），
        // 只有把 last_announced 改成功的那一次去发，另一次 updated 为 0 直接退出。
        const claim = await db.collection('shops')
          .where({ _id: shop._id, last_announced: _.neq(session.key) })
          .update({ data: { last_announced: session.key } })
        if (!claim.stats || claim.stats.updated === 0) return { success: true, announced: false }

        await ensureCollection()
        const result = await fanOut(shop, session)
        console.info('开团提醒：', shop._id, session.key, result)
        return { success: true, announced: true, sent: result.sent }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('shopSubscribe 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
