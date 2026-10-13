const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 一起拼团的定时结算。config.json 里挂了每 5 分钟一次的 timer 触发器。
//
// 一场拼团（shop_sessions 一条）的一生：
//   open      拼团中。买家下单，订单是 forming
//             截单前 2 小时还没到门槛：给已下单的买家各发一条拼团进度通知，喊人（只发一次）
//   ↓ 截单（cutoff_at）
//   formed    成团：订单 forming → confirming（「待确认」），买家在 confirm_at 前联系店长确认
//   failed    没成团：订单全部取消，原因「未成团」
//   cancelled 店长手动取消（shopManage 的 cancelSession）
//   ↓ 出发（depart_at）
//   ended = true。开了每周重复的，这时候开下周同一时间的新场次
//
// 每一步都是「带着旧状态做条件更新」：更新成功的那一次才往下做（发通知、开新场），
// 两个实例前后脚跑到同一场也只有一个改得动。所以这个函数重复跑、跑到一半超时都没关系，
// 下一轮会接着把剩下的做完——这也是为什么场次和订单分两遍处理，而不是在一遍里连着改。
//
// 时间一律是明尼苏达当地时间的 'YYYY-MM-DD HH:MM' 字符串，直接按字符串比大小。
// 这段时间换算和 shopManage / shopBrowse / buyerOrders 里的是同一份——
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

// '2026-10-13 22:00' + 720 → '2026-10-14 10:00'。当成 UTC 算只为了做加减，不涉及时区换算
function shiftAt(at, minutes) {
  const d = new Date(at.replace(' ', 'T') + ':00Z')
  d.setUTCMinutes(d.getUTCMinutes() + minutes)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

// 截单在出发前一天；确认截止 = 截单后 12 小时，最晚出发前 1 小时。
// 和 shopManage 的 buildTimes 是同一份
function buildTimes(date, departTime, cutoffTime) {
  const departAt = date + ' ' + departTime
  const cutoffAt = shiftAt(date + ' ' + cutoffTime, -24 * 60)
  const a = shiftAt(cutoffAt, 12 * 60)
  const b = shiftAt(departAt, -60)
  return { depart_at: departAt, cutoff_at: cutoffAt, confirm_at: a < b ? a : b }
}

const MAX_ACTIVE = 4     // 一家店同时开着的场次上限，和 shopManage 一致
const REMIND_BEFORE = 120  // 截单前多少分钟发「还差 N 位」
const BATCH = 100        // 一轮最多处理多少单
const SEND_CHUNK = 20    // 通知并发数

// '2026-10-14 10:00' → '10/14 10:00'
function shortAt(at) {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(at || '')
  return m ? Number(m[1]) + '/' + Number(m[2]) + ' ' + m[3] : at
}

function itemText(order) {
  const items = order.items || []
  const first = items[0] || {}
  return (first.name || '你的订单') + (items.length > 1 ? ' 等 ' + items.length + ' 件' : '')
}

// 订单进度通知，用的是买家下单时授权的那张票。发不出去是常态（没授权、票用掉了），不影响结算
function notifyBuyer(order, status, tip) {
  return cloud.callFunction({
    name: 'sendSubscribe',
    data: {
      tpl: 'orderProgress',
      toUser: order.buyer,
      page: 'pages/myshoporders/myshoporders',
      data: { status: status, item: itemText(order), time: nowAt() + ':00', tip: tip }
    }
  }).catch(e => console.warn('拼团通知发送失败：', e))
}

async function inChunks(list, fn) {
  for (let i = 0; i < list.length; i += SEND_CHUNK) {
    await Promise.all(list.slice(i, i + SEND_CHUNK).map(fn))
  }
}

async function countOrders(sessionId) {
  const res = await db.collection('shop_orders')
    .where({ session_id: sessionId, status: _.neq('cancelled') })
    .count()
  return res.total
}

// 第零遍：截单前 2 小时还没成团的场次，提醒已经下单的人去拉人。
// 用的是下单时单独要的那张拼团进度票，不占订单进度那张（成团通知要用）。
// 先把场次标成 reminded 再发，同一场只发一次；够门槛的、照常送的也标上，下一轮不再看
async function remindSessions(now) {
  const res = await db.collection('shop_sessions')
    .where({
      state: 'open',
      reminded: _.neq(true),
      min_orders: _.gt(0),
      cutoff_at: _.gt(now).and(_.lte(shiftAt(now, REMIND_BEFORE)))
    })
    .limit(50)
    .get()

  for (const s of res.data) {
    const claim = await db.collection('shop_sessions')
      .where({ _id: s._id, reminded: _.neq(true) })
      .update({ data: { reminded: true } })
    if (!claim.stats || claim.stats.updated !== 1) continue

    const count = await countOrders(s._id)
    const gap = s.min_orders - count
    if (gap <= 0 || s.forced === true || count === 0) continue

    const orders = await db.collection('shop_orders')
      .where({ session_id: s._id, status: 'forming' })
      .field({ buyer: true })
      .limit(500)
      .get()
    const buyers = [...new Set(orders.data.map(o => o.buyer))]
    const name = Array.from(s.shop_name || '').slice(0, 10).join('') + ' ' +
      Number(s.date.slice(5, 7)) + '/' + Number(s.date.slice(8)) + ' 拼团'
    await inChunks(buyers, buyer => cloud.callFunction({
      name: 'sendSubscribe',
      data: {
        tpl: 'groupProgress',
        toUser: buyer,
        page: 'pages/myshoporders/myshoporders',
        data: { name: name, min: s.min_orders, gap: '还差 ' + gap + ' 位', cutoff: s.cutoff_at }
      }
    }).catch(e => console.warn('拼团进度通知发送失败：', e)))
  }
  return res.data.length
}

// 第一遍：到了截单时间的场次，判定成没成团。只改场次，订单留给第二遍
async function settleSessions(now) {
  const res = await db.collection('shop_sessions')
    .where({ state: 'open', cutoff_at: _.lte(now) })
    .limit(50)
    .get()

  for (const s of res.data) {
    const count = await countOrders(s._id)
    const formed = !s.min_orders || s.forced === true || count >= s.min_orders
    await db.collection('shop_sessions')
      .where({ _id: s._id, state: 'open' })
      .update({
        data: {
          state: formed ? 'formed' : 'failed',
          order_count: count,
          settled_at: new Date(),
          updated_at: new Date()
        }
      })
  }
  return res.data.length
}

// 第二遍：截单时间已过、还在 forming 的单，按所在场次的结果推进
async function settleOrders(now) {
  const res = await db.collection('shop_orders')
    .where({ status: 'forming', cutoff_at: _.lte(now) })
    .limit(BATCH)
    .get()
  if (!res.data.length) return 0

  const ids = [...new Set(res.data.map(o => o.session_id))]
  const sessions = await db.collection('shop_sessions').where({ _id: _.in(ids) }).limit(ids.length).get()
  const byId = {}
  sessions.data.forEach(s => { byId[s._id] = s })

  await inChunks(res.data, async o => {
    const s = byId[o.session_id]
    // 场次还没判（第一遍这轮没轮到），下一轮再来
    if (!s || s.state === 'open') return

    let patch
    let notice
    if (s.state === 'formed') {
      patch = { status: 'confirming' }
      notice = ['待确认', '请在' + shortAt(o.confirm_at) + '前联系店长确认']
    } else if (s.state === 'failed') {
      const gap = Math.max(1, (s.min_orders || 0) - (s.order_count || 0))
      patch = { status: 'cancelled', cancel_reason: '未成团' }
      notice = ['未成团', '差 ' + gap + ' 单没拼成，订单已取消']
    } else {
      patch = { status: 'cancelled', cancel_reason: '店长取消了这一场' }
      notice = ['已取消', '店长取消了这一场']
    }

    const done = await db.collection('shop_orders')
      .where({ _id: o._id, status: 'forming' })
      .update({ data: Object.assign(patch, { updated_at: new Date() }) })
    if (done.stats && done.stats.updated === 1) await notifyBuyer(o, notice[0], notice[1])
  })
  return res.data.length
}

// 第三遍：确认截止已过、店长还没确认的单，自动取消并记一次爽约。
// 买家那张通知票在成团时已经用掉了，这里不再发
async function expireUnconfirmed(now) {
  const res = await db.collection('shop_orders')
    .where({ status: 'confirming', confirm_at: _.lte(now) })
    .limit(BATCH)
    .field({ _id: true })
    .get()

  for (const o of res.data) {
    await db.collection('shop_orders')
      .where({ _id: o._id, status: 'confirming' })
      .update({
        data: {
          status: 'cancelled',
          cancel_reason: '超时未确认',
          no_show: true,
          no_show_at: new Date(),
          updated_at: new Date()
        }
      })
  }
  return res.data.length
}

// 第四遍：出发时间已过的场次收尾；开了每周重复的，开下周同一时间的新场次
async function endSessions(now) {
  const res = await db.collection('shop_sessions')
    .where({
      state: _.in(['formed', 'failed', 'cancelled']),
      ended: _.neq(true),
      depart_at: _.lte(now)
    })
    .limit(50)
    .get()

  for (const s of res.data) {
    const claim = await db.collection('shop_sessions')
      .where({ _id: s._id, ended: _.neq(true) })
      .update({ data: { ended: true, updated_at: new Date() } })
    if (!claim.stats || claim.stats.updated !== 1) continue
    if (s.repeat_weekly === true) await repeatNextWeek(s, now)
  }
  return res.data.length
}

function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function repeatNextWeek(s, now) {
  let shop = null
  try {
    shop = (await db.collection('shops').doc(s.shop_id).get()).data
  } catch (e) {
    shop = null
  }
  // 店删了、被下架了，就不再往下排
  if (!shop || shop.takedown) return

  // 下周那天已经过了截单（场次积压了好几周才轮到这里），往后顺延到赶得上的那一周
  let date = addDays(s.date, 7)
  let times = buildTimes(date, s.depart_time, s.cutoff)
  while (times.cutoff_at <= now) {
    date = addDays(date, 7)
    times = buildTimes(date, s.depart_time, s.cutoff)
  }

  const live = await db.collection('shop_sessions')
    .where({ shop_id: s.shop_id, ended: _.neq(true), state: _.in(['open', 'formed']) })
    .field({ date: true })
    .limit(MAX_ACTIVE + 1)
    .get()
  if (live.data.length >= MAX_ACTIVE) return
  if (live.data.some(x => x.date === date)) return

  // 取货点按店铺现在的设置刷新：店长这周改了价、删了点，下周跟着变
  const names = (s.points || []).map(p => p.name)
  const points = (shop.pickup_points || []).filter(p => names.indexOf(p.name) !== -1)
  if (!points.length && !shop.exact_address) return

  const added = await db.collection('shop_sessions').add({
    data: Object.assign({
      shop_id: s.shop_id,
      shop_name: shop.name,
      owner: shop.owner,
      date: date,
      depart_time: s.depart_time,
      cutoff: s.cutoff,
      min_orders: s.min_orders || 0,
      repeat_weekly: true,
      points: points,
      forced: false,
      state: 'open',
      ended: false,
      announced: false,
      created_at: new Date(),
      updated_at: new Date()
    }, times)
  })

  // 开团提醒发给订阅了这家店的人。云函数之间调用不带 OPENID，shopSubscribe 据此放行
  await cloud.callFunction({
    name: 'shopSubscribe',
    data: { action: 'announceSession', sessionId: added._id }
  }).catch(e => console.warn('每周重复的开团提醒失败：', e))
}

exports.main = async () => {
  const now = nowAt()
  const result = {}
  try {
    result.reminded = await remindSessions(now)
    result.sessions = await settleSessions(now)
    result.orders = await settleOrders(now)
    result.expired = await expireUnconfirmed(now)
    result.ended = await endSessions(now)
  } catch (err) {
    // 集合还没建（还没人开过团）时 shop_sessions 查询会报 -502005，算正常
    console.error('groupSettle 失败：', err)
    result.error = String((err && err.errMsg) || err)
  }
  if (result.reminded || result.sessions || result.orders || result.expired || result.ended) console.info('拼团结算：', now, result)
  return result
}
