const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 一起拼团的「开团提醒」：买家订阅一家店，店长每开一场就发一条微信通知。
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
// 什么算「开团」：shop_sessions 里新开了一场（店长在「我的小店」开的，
// 或者 groupSettle 按每周重复开的）。场次上的 announced 记住发没发过，同一场只通知一次。
// 模板是「产品截团通知」，截团时间正好装这一场的截单时刻。

// 场次时间一律是明尼苏达当地时间的 'YYYY-MM-DD HH:MM' 字符串，直接按字符串比大小。
// 这段和 groupSettle / shopManage / shopBrowse / buyerOrders 里的是同一份——
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
        if (!shop || shop.takedown) return { success: false, message: '店铺不存在' }

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

      // 新开了一场之后调一次（不等结果）。两个来源：
      //   小程序端：店长开团成功后，只认自己店的场次，别人没法替某家店「开团」去骚扰订阅者
      //   groupSettle：每周重复开的新场次。云函数之间调用不带 OPENID，据此放行
      // 幂等：场次上的 announced 只改得动一次，多调几次也不会重复打扰人。
      case 'announceSession': {
        let s = null
        try {
          s = (await db.collection('shop_sessions').doc(String(event.sessionId || '')).get()).data
        } catch (e) {
          s = null
        }
        if (!s) return { success: false, message: '场次不存在' }
        if (openid && s.owner !== openid) return { success: false, message: '没有权限' }
        if (s.state !== 'open' || s.cutoff_at <= nowAt()) return { success: true, announced: false }

        const shop = await getShop(s.shop_id)
        if (!shop || shop.takedown) return { success: true, announced: false }

        // 先占位再发：只有把 announced 改成功的那一次去发
        const claim = await db.collection('shop_sessions')
          .where({ _id: s._id, announced: _.neq(true) })
          .update({ data: { announced: true } })
        if (!claim.stats || claim.stats.updated === 0) return { success: true, announced: false }

        await ensureCollection()
        const result = await fanOut(shop, {
          // time 类型字段要「2026-09-25 16:00」这种格式，正好是 cutoff_at
          cutoff: s.cutoff_at,
          tip: Number(s.date.slice(5, 7)) + '/' + Number(s.date.slice(8)) + ' ' + s.depart_time + ' 出发'
        })
        console.info('开团提醒：', shop._id, s._id, result)
        return { success: true, announced: true, sent: result.sent }
      }

      // 旧版小程序保存设置、开门营业后还会调这个。场次已经不存在店铺上了，什么都不做
      case 'announce':
        return { success: true, announced: false }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('shopSubscribe 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
