const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 店长自助管理：店铺资料、拼团场次、商品，外加管理员发开店码。
//
// 这些 action 合在一个云函数里，是因为它们全都要先过同一道
// 「这家店到底是不是你的」校验。拆成好几个函数就得把那段逻辑抄好几遍，
// 而且每加一个 action 你就得在开发者工具里多点一次部署。
//
// 注意：云函数写库不会自动带 _openid（那是小程序端 add 才有的），
// 所以店铺、场次和商品的归属都用显式的 owner 字段存。
//
// 2026-10-11 改成「一起拼团」：
//   - 店铺不再有「营业中 / 打烊」。某天能不能下单只看那天有没有场次；
//     shops.status 只剩被举报下架时写的 closed（和 takedown 一起），别处不再读它
//   - 场次从 shops.batches 搬到 shop_sessions 集合，一家店最多同时开 MAX_ACTIVE 场。
//     老店铺上的 batches 留着不读
//   - 开店要开店码（shop_create_codes），管理员在「我的 → 开店码」生成

// 场次时间一律按明尼苏达当地时间、存成 'YYYY-MM-DD HH:MM' 字符串，直接按字符串比大小。
// 这段和 groupSettle / shopBrowse / buyerOrders 里的是同一份——
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

// 截单固定在出发前一天，店长只选几点；确认截止不让店长填：
// 截单后 12 小时，最晚出发前 1 小时。和 groupSettle 的 buildTimes 是同一份
function buildTimes(date, departTime, cutoffTime) {
  const departAt = date + ' ' + departTime
  const cutoffAt = shiftAt(date + ' ' + cutoffTime, -24 * 60)
  const a = shiftAt(cutoffAt, 12 * 60)
  const b = shiftAt(departAt, -60)
  return { depart_at: departAt, cutoff_at: cutoffAt, confirm_at: a < b ? a : b }
}

const MAX_ACTIVE = 4          // 一家店同时开着的场次上限
const CALENDAR_DAYS = 14      // 开团日历往后看两周
const MIN_CONFIRM_MINUTES = 60  // 确认期至少留 1 小时，不然买家来不及联系店长
const CODE_DAYS = 7           // 开店码有效期

const isTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s)

function cleanPickupPoints(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(p => p && String(p.name || '').trim())
    .map(p => ({
      // 一句话就是取货点（「Coffman 门口」），不再拆名称 + 具体位置两格。
      // 它同时是订单里引用的标识符，所以限长，别让它长成一段描述。
      name: String(p.name).trim().slice(0, 20),
      fee: Math.max(0, Number(p.fee) || 0),
      // 出发后多久到这个点（分钟）。买家看到的预计送达 = 场次的出发时间 + 它
      eta_minutes: Math.max(0, Math.min(180, Math.floor(Number(p.eta_minutes) || 0)))
    }))
}

// 拿到自己的店。没有就返回 null，不算错误——新用户本来就没有店。
async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

// 开店码管理归运营管理员和超管，和开队码同一拨人
async function isShopAdmin(openid) {
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  const roles = (me.data[0] && me.data[0].roles) || []
  return roles.includes('super_admin') || roles.includes('ops_admin')
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // 去掉了 0/O/1/I/l

function makeCode(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length))
  return s
}

// 新集合第一次用时自动建，省得上线前漏了在控制台手建（漏建时查询报 -502005）。
// 每个实例建一次；已存在时 createCollection 报错，吞掉即可
let collectionsReady = false
async function ensureCollections() {
  if (collectionsReady) return
  for (const name of ['shop_sessions', 'shop_create_codes']) {
    try {
      await db.createCollection(name)
    } catch (e) { /* 已经存在 */ }
  }
  collectionsReady = true
}

// 店铺资料。取货点只存买家看得到的那部分：名字、配送费、出发后多久到。
//
// 有没有线下交付（needs_delivery）不再由店长选：2026-10-11 起新店一律要线下交付，
// 老的纯线上服务店保留原值（见 update），只是开不了团。
// 送到买家地址（exact_address）现在关着（小程序端 EXACT_ADDRESS_ENABLED），老数据照旧读写。
function pickShopFields(event, needsDelivery) {
  const exact = needsDelivery && event.exact_address === true

  return {
    name: (event.name || '').trim(),
    description: (event.description || '').trim(),
    logo: event.logo || '',
    min_order: Number(event.min_order) || 0,

    // 店长自己写给买家看的一段话（取货约定、备注怎么填、多久回复…）。
    // 平台不替店长生成这段，也不审它——写什么、写不写都由店长决定。
    order_notice: (event.order_notice || '').trim().slice(0, 300),
    // 2026-10-13 起店长联系方式从微信号换成手机号：收款走邮件，买家有急事打电话。
    // 老店的 contact_wechat 留在库里不动，买家订单页在店长没填手机时还显示它
    contact_phone: String(event.contact_phone || '').trim().slice(0, 30),

    // 广告语：海报大标题、店长自己转发时的卡片标题。小程序端保存前过内容检测
    slogan: Array.from((event.slogan || '').trim()).slice(0, 16).join(''),

    // 下单时要不要买家补充说明（尺寸、颜色、口味、参考图这类）。
    // 默认关闭：多数店卖的是标品，硬加一步只会挡住下单。
    // note_hint 是店长自己写的提示语，直接当买家那个输入框的 placeholder。
    note_required: event.note_required === true,
    note_hint: (event.note_hint || '').trim().slice(0, 60),

    exact_address: exact,
    flat_delivery_fee: exact
      ? Math.round(Math.max(0, Number(event.flat_delivery_fee) || 0) * 100) / 100
      : 0,

    // 资质凭证选填，不作为入驻门槛。平台不核实、也没有能力核实，
    // 传了就留档——出事时这是责任在谁的直接证据。
    license_image: event.license_image || '',

    pickup_points: (needsDelivery && !exact) ? cleanPickupPoints(event.pickup_points) : []
  }
}

function validateShop(fields, needsDelivery) {
  if (!fields.name) return '请填写小店名称'
  const phoneDigits = fields.contact_phone.replace(/\D/g, '')
  if (phoneDigits.length < 10 || phoneDigits.length > 15) return '请填写正确的手机号'
  if (needsDelivery && !fields.exact_address && !fields.pickup_points.length) {
    return '至少设一个取货点'
  }
  const names = fields.pickup_points.map(p => p.name)
  if (new Set(names).size !== names.length) return '取货点名字不能重复'
  return null
}

// ---- 场次 ----

// 我的店开着的场次：还没出发的，含已成团、在确认期的
async function mySessions(shopId) {
  const res = await db.collection('shop_sessions')
    .where({ shop_id: shopId, ended: _.neq(true), state: _.in(['open', 'formed', 'failed', 'cancelled']) })
    .orderBy('depart_at', 'asc')
    .limit(20)
    .get()
  return res.data
}

// 每一场的单数，按状态分开数：拼团中 / 待确认 / 已确认（备餐、配送、完成）
async function countBySession(ids) {
  const out = {}
  ids.forEach(id => { out[id] = { total: 0, forming: 0, confirming: 0, confirmed: 0 } })
  if (!ids.length) return out
  const $ = db.command.aggregate
  const res = await db.collection('shop_orders').aggregate()
    .match({ session_id: _.in(ids), status: _.neq('cancelled') })
    .group({ _id: { s: '$session_id', st: '$status' }, n: $.sum(1) })
    .end()
  res.list.forEach(r => {
    const c = out[r._id.s]
    if (!c) return
    c.total += r.n
    if (r._id.st === 'forming') c.forming += r.n
    else if (r._id.st === 'confirming') c.confirming += r.n
    else c.confirmed += r.n
  })
  return out
}

// 场次表单校验。返回 { error } 或 { fields }
function cleanSession(event, shop, now) {
  const date = String(event.date || '')
  const depart = String(event.depart_time || '')
  const cutoff = String(event.cutoff || '')
  if (!isDate(date) || !isTime(depart) || !isTime(cutoff)) return { error: '时间不完整' }

  const times = buildTimes(date, depart, cutoff)
  if (times.cutoff_at <= now) return { error: '截单时间已经过了，换一天' }
  if (times.confirm_at < shiftAt(times.cutoff_at, MIN_CONFIRM_MINUTES)) {
    return { error: '出发太早，留不出确认时间' }
  }

  const min = Math.max(0, Math.min(200, Math.floor(Number(event.min_orders) || 0)))

  // 这一场去哪几个点：从店铺的取货点里挑，存一份快照。
  // 之后店长改了店铺的取货点，已经开着的场次和已下的单不跟着变
  const wanted = Array.isArray(event.points) ? event.points.map(String) : []
  const points = (shop.pickup_points || []).filter(p => wanted.indexOf(p.name) !== -1)
  if (!shop.exact_address && !points.length) return { error: '至少选一个取货点' }

  return {
    fields: Object.assign({
      date: date,
      depart_time: depart,
      cutoff: cutoff,
      min_orders: min,
      repeat_weekly: event.repeat_weekly === true,
      points: points
    }, times)
  }
}

// 给店长看的同一天别家的场次：只给买家本来就看得到的东西，不给单数
function publicSession(s) {
  return {
    shop_name: s.shop_name,
    date: s.date,
    depart_time: s.depart_time,
    points: (s.points || []).map(p => p.name)
  }
}

// 被店长取消的那一场：还在进行中的单一起取消，能发通知的发一条
async function cancelSessionOrders(session, reason) {
  const res = await db.collection('shop_orders')
    .where({ session_id: session._id, status: _.in(['forming', 'confirming', 'accepted']) })
    .limit(500)
    .get()
  for (const o of res.data) {
    const done = await db.collection('shop_orders')
      .where({ _id: o._id, status: o.status })
      .update({ data: { status: 'cancelled', cancel_reason: reason, updated_at: new Date() } })
    if (!done.stats || done.stats.updated !== 1) continue
    const items = o.items || []
    cloud.callFunction({
      name: 'sendSubscribe',
      data: {
        tpl: 'orderProgress',
        toUser: o.buyer,
        page: 'pages/myshoporders/myshoporders',
        data: {
          status: '已取消',
          item: ((items[0] || {}).name || '你的订单') + (items.length > 1 ? ' 等 ' + items.length + ' 件' : ''),
          time: nowAt() + ':00',
          tip: reason
        }
      }
    }).catch(e => console.warn('取消通知发送失败：', e))
  }
  return res.data.length
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    switch (action) {

      // ---- 店铺 ----

      case 'getMine': {
        const shop = await getMyShop(openid)
        return { success: true, shop: shop }
      }

      // 首次入驻。要开店码；已经有店的话走 update，不允许一个人开两家
      case 'apply': {
        const existing = await getMyShop(openid)
        if (existing) return { success: false, message: '你已经有一家店了' }

        if (!event.agreed) {
          return { success: false, message: '请先阅读并同意《店长责任告知书》' }
        }

        const fields = pickShopFields(event, true)
        const invalid = validateShop(fields, true)
        if (invalid) return { success: false, message: invalid }

        // 开店码：先占住（带 used: false 的条件更新，两个人拿同一个码同时提交
        // 只有一个改得动），开店失败再还回去
        //
        // 这里不调 ensureCollections：手里有码，说明管理员生成过，集合早就在了。
        // 冷启动时多两趟 createCollection 很容易把开店顶过云函数默认的 3 秒超时，
        // 前端只能看到调用失败。集合真不存在（-502005）就当码不对
        const code = String(event.create_code || '').trim().toUpperCase()
        if (!code) return { success: false, message: '请填写开店码' }
        const found = await db.collection('shop_create_codes').where({ code: code }).limit(1).get()
          .catch(e => {
            if (e && e.errCode === -502005) return { data: [] }
            throw e
          })
        const ticket = found.data[0]
        if (!ticket || ticket.used) return { success: false, message: '开店码不对或已用过' }
        if (new Date(ticket.expires_at) < new Date()) return { success: false, message: '开店码已过期' }
        const claim = await db.collection('shop_create_codes')
          .where({ _id: ticket._id, used: false })
          .update({ data: { used: true, used_by: openid, used_at: new Date() } })
        if (!claim.stats || claim.stats.updated !== 1) {
          return { success: false, message: '开店码不对或已用过' }
        }

        let res
        try {
          res = await db.collection('shops').add({
            data: Object.assign({}, fields, {
              owner: openid,
              needs_delivery: true,
              // 平台不做事前审核，开店码就是门槛。status 只给举报下架用（closed），别处不读
              status: 'open',
              agreed_at: new Date(),     // 同意告知书的时间
              created_at: new Date(),
              updated_at: new Date()
            })
          })
        } catch (e) {
          await db.collection('shop_create_codes').doc(ticket._id).update({
            data: { used: false, used_by: '', used_at: null }
          })
          throw e
        }
        await db.collection('shop_create_codes').doc(ticket._id).update({
          data: { shop_id: res._id, shop_name: fields.name }
        })
        return { success: true, shopId: res._id }
      }

      case 'update': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        // 老的纯线上服务店保留原值，界面上已经没有这个开关了
        const needsDelivery = shop.needs_delivery !== false
        const fields = pickShopFields(event, needsDelivery)
        const invalid = validateShop(fields, needsDelivery)
        if (invalid) return { success: false, message: invalid }

        // 场次不在这里存（见 openSession），保存设置不会碰到已经开着的团
        await db.collection('shops').doc(shop._id).update({
          data: Object.assign({}, fields, { updated_at: new Date() })
        })
        // 场次上存了一份店名（别家店长的日历、截单提醒用），改了名还没结束的场次跟着改。
        // 订单上的店名是下单那一刻的快照，不动
        if (fields.name !== shop.name) {
          await db.collection('shop_sessions')
            .where({ shop_id: shop._id, ended: _.neq(true) })
            .update({ data: { shop_name: fields.name } })
            .catch(() => {})
        }
        return { success: true }
      }

      // 海报风格：杂志 / 黑板 / 手账，店长在海报页挑，转发卡片和店铺页跟着用。
      // 单独一个 action，不并进 pickShopFields——不然保存小店设置会把它清掉
      case 'setPosterStyle': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        const style = ['magazine', 'chalkboard', 'scrapbook'].indexOf(event.style) !== -1 ? event.style : 'magazine'
        await db.collection('shops').doc(shop._id).update({ data: { poster_style: style, updated_at: new Date() } })
        return { success: true, style: style }
      }

      // ---- 场次 ----

      // 「我的小店」一次拿齐：我开着的场次（带单数）+ 两周内别家的排期
      case 'sessions': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        await ensureCollections()

        const now = nowAt()
        const today = now.slice(0, 10)
        const last = shiftAt(today + ' 12:00', (CALENDAR_DAYS - 1) * 24 * 60).slice(0, 10)
        const [mine, others] = await Promise.all([
          mySessions(shop._id),
          db.collection('shop_sessions')
            .where({
              shop_id: _.neq(shop._id),
              state: _.in(['open', 'formed']),
              date: _.gte(today).and(_.lte(last))
            })
            .limit(100)
            .get()
        ])
        const counts = await countBySession(mine.map(s => s._id))

        return {
          success: true,
          now: now,
          sessions: mine.map(s => Object.assign({}, s, { counts: counts[s._id] })),
          others: others.data.map(publicSession)
        }
      }

      // 开团页要的东西：店铺的取货点、这一天别家的场次；改场次时再带上这一场和它的单数
      case 'sessionForm': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        await ensureCollections()

        let session = null
        let count = 0
        if (event.sessionId) {
          const doc = await db.collection('shop_sessions').doc(event.sessionId).get()
          session = doc.data
          if (!session || session.shop_id !== shop._id) return { success: false, message: '没有权限' }
          count = (await countBySession([session._id]))[session._id].total
        }
        const date = session ? session.date : String(event.date || '')
        const others = isDate(date)
          ? await db.collection('shop_sessions')
            .where({ shop_id: _.neq(shop._id), state: _.in(['open', 'formed']), date: date })
            .limit(20)
            .get()
          : { data: [] }

        return {
          success: true,
          now: nowAt(),
          points: shop.pickup_points || [],
          exact_address: shop.exact_address === true,
          session: session,
          count: count,
          others: others.data.map(publicSession)
        }
      }

      case 'openSession': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        if (shop.takedown) return { success: false, message: '店铺已被下架' }
        if (shop.needs_delivery === false) return { success: false, message: '线上服务的店开不了团' }
        await ensureCollections()

        // 店里还没商品就开团，买家点进来什么都买不了
        const items = await db.collection('shop_items')
          .where({ shop_id: shop._id, available: _.neq(false) })
          .count()
        if (!items.total) return { success: false, message: '先上架商品再开团' }

        const now = nowAt()
        const cleaned = cleanSession(event, shop, now)
        if (cleaned.error) return { success: false, message: cleaned.error }

        const live = await mySessions(shop._id)
        const active = live.filter(s => s.state === 'open' || s.state === 'formed')
        if (active.length >= MAX_ACTIVE) return { success: false, message: '最多同时开 ' + MAX_ACTIVE + ' 场' }
        if (active.some(s => s.date === cleaned.fields.date)) return { success: false, message: '这天已经开过团了' }

        const res = await db.collection('shop_sessions').add({
          data: Object.assign({
            shop_id: shop._id,
            shop_name: shop.name,
            owner: openid,
            forced: false,
            state: 'open',
            ended: false,
            announced: false,
            created_at: new Date(),
            updated_at: new Date()
          }, cleaned.fields)
        })
        return { success: true, sessionId: res._id }
      }

      // 改场次。截单前才能改；有人下单后日期、时间、取货点都定死了，
      // 只能调低门槛、开关每周重复——不然已经下单的人会发现自己参的团变了样
      case 'updateSession': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        const doc = await db.collection('shop_sessions').doc(event.sessionId).get()
        const s = doc.data
        if (!s || s.shop_id !== shop._id) return { success: false, message: '没有权限' }

        const now = nowAt()
        if (s.state !== 'open' || s.cutoff_at <= now) {
          // 截单后只剩「每周重复」还有意义：决定下周还开不开
          if (s.ended) return { success: false, message: '这一场已经结束了' }
          await db.collection('shop_sessions').doc(s._id).update({
            data: { repeat_weekly: event.repeat_weekly === true, updated_at: new Date() }
          })
          return { success: true }
        }

        const count = (await countBySession([s._id]))[s._id].total
        if (count > 0) {
          const min = Math.max(0, Math.floor(Number(event.min_orders) || 0))
          if (min > (s.min_orders || 0)) {
            return { success: false, message: '已经有人下单，门槛只能调低' }
          }
          await db.collection('shop_sessions').where({ _id: s._id, state: 'open' }).update({
            data: { min_orders: min, repeat_weekly: event.repeat_weekly === true, updated_at: new Date() }
          })
          return { success: true }
        }

        const cleaned = cleanSession(event, shop, now)
        if (cleaned.error) return { success: false, message: cleaned.error }
        if (cleaned.fields.date !== s.date) {
          const live = await mySessions(shop._id)
          if (live.some(x => x._id !== s._id && x.date === cleaned.fields.date && (x.state === 'open' || x.state === 'formed'))) {
            return { success: false, message: '这天已经开过团了' }
          }
        }
        // 改了时间，截单前那条拼团进度提醒按新的截单时间重新算
        await db.collection('shop_sessions').where({ _id: s._id, state: 'open' }).update({
          data: Object.assign({ reminded: false, updated_at: new Date() }, cleaned.fields)
        })
        return { success: true }
      }

      // 照常送：差几单没到门槛，店长愿意送，截单时就按成团算
      case 'forceSession': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        const res = await db.collection('shop_sessions')
          .where({ _id: String(event.sessionId || ''), shop_id: shop._id, state: 'open' })
          .update({ data: { forced: true, updated_at: new Date() } })
        if (!res.stats || res.stats.updated !== 1) return { success: false, message: '这一场已经截单了' }
        return { success: true }
      }

      // 取消这一场。出发前都能取消，进行中的单一起取消。
      // 每周重复不受影响：下周照常开，不想开了就先关掉每周重复
      case 'cancelSession': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        const doc = await db.collection('shop_sessions').doc(event.sessionId).get()
        const s = doc.data
        if (!s || s.shop_id !== shop._id) return { success: false, message: '没有权限' }
        if (s.ended || s.depart_at <= nowAt()) return { success: false, message: '这一场已经出发了' }

        const claim = await db.collection('shop_sessions')
          .where({ _id: s._id, state: _.in(['open', 'formed']) })
          .update({ data: { state: 'cancelled', updated_at: new Date() } })
        if (!claim.stats || claim.stats.updated !== 1) return { success: false, message: '这一场已经结束了' }

        const n = await cancelSessionOrders(s, '店长取消了这一场')
        return { success: true, cancelled: n }
      }

      // ---- 开店码（管理员） ----

      case 'makeShopCode': {
        if (!(await isShopAdmin(openid))) return { success: false, message: '没有权限' }
        await ensureCollections()
        const code = makeCode(8)
        const expires = new Date(Date.now() + CODE_DAYS * 24 * 3600 * 1000)
        await db.collection('shop_create_codes').add({
          data: {
            code: code,
            note: String(event.note || '').trim().slice(0, 30),
            created_by: openid,
            created_at: new Date(),
            expires_at: expires,
            used: false
          }
        })
        return { success: true, code: code, expires_at: expires }
      }

      case 'listShopCodes': {
        if (!(await isShopAdmin(openid))) return { success: false, message: '没有权限' }
        await ensureCollections()
        const res = await db.collection('shop_create_codes').orderBy('created_at', 'desc').limit(50).get()
        return { success: true, codes: res.data }
      }

      // 店长自己删店。删掉店铺、商品、场次、开团订阅和还没人接的配送请求；
      // 订单和办过的配送请求留着——上面有店名快照，买家和配送队的记录不能跟着没了。
      //
      // 两种情况不让删：
      //   1. 还有没办完的订单，或者配送队已经接了的请求——对面还在等，
      //      店一删，买家连店长微信都查不到了
      //   2. 被举报下架的店——删了就能重开一家，下架等于没下架
      case 'remove': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        if (shop.takedown) {
          return { success: false, message: '店铺因违规被下架，不能自行删除，如有异议请通过意见反馈联系我们' }
        }

        const busyOrders = await db.collection('shop_orders')
          .where({ shop_id: shop._id, status: _.in(['forming', 'confirming', 'pending', 'accepted', 'delivering']) })
          .count()
        if (busyOrders.total > 0) {
          return { success: false, message: '还有 ' + busyOrders.total + ' 单没完成，处理完再删' }
        }
        const busyRequests = await db.collection('delivery_requests')
          .where({ shop_id: shop._id, status: 'accepted' })
          .count()
        if (busyRequests.total > 0) {
          return { success: false, message: '有配送队接了你的请求还没送完，等送达或标「没来送」后再删' }
        }

        const items = await db.collection('shop_items')
          .where({ shop_id: shop._id }).field({ image: true }).limit(1000).get()
        const files = [shop.logo, shop.license_image]
          .concat(items.data.map(i => i.image))
          .filter(f => typeof f === 'string' && f.indexOf('cloud://') === 0)

        await db.collection('shop_items').where({ shop_id: shop._id }).remove()
        await db.collection('shop_subscriptions').where({ shop_id: shop._id }).remove()
        await db.collection('shop_sessions').where({ shop_id: shop._id }).remove().catch(() => {})
        await db.collection('delivery_requests').where({ shop_id: shop._id, status: 'open' }).remove()
        await db.collection('shops').doc(shop._id).remove()

        // 图片删不掉不影响结果，店已经没了。deleteFile 一次最多 50 个
        for (let i = 0; i < files.length; i += 50) {
          try {
            await cloud.deleteFile({ fileList: files.slice(i, i + 50) })
          } catch (e) {
            console.warn('删除店铺图片失败（不影响结果）：', e)
          }
        }
        return { success: true }
      }

      // ---- 商品 ----

      case 'listItems': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const res = await db.collection('shop_items')
          .where({ shop_id: shop._id })
          .orderBy('created_at', 'asc')
          .limit(200)
          .get()
        return {
          success: true,
          items: res.data,
          useCategory: shop.use_category === true
        }
      }

      // 商品分类开关。独立成一个 action 而不是并进 pickShopFields——
      // 并进去的话，店长在「小店设置」里点一次保存就会把这个开关清掉。
      case 'setUseCategory': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有小店' }
        await db.collection('shops').doc(shop._id).update({
          data: { use_category: event.use === true, updated_at: new Date() }
        })
        return { success: true }
      }

      // 新增或修改商品。带 itemId 就是改，不带就是加。
      case 'saveItem': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const name = (event.name || '').trim()
        const price = Number(event.price)
        if (!name) return { success: false, message: '请填写商品名称' }
        if (!(price >= 0)) return { success: false, message: '请填写正确的价格' }

        const data = {
          name: name,
          price: price,
          description: (event.description || '').trim(),
          // 计价单位。自由填而不是给枚举：零售论件、代购论份、美甲论次、
          // 摄影论小时，枚举永远差一个。空着就只显示价格，跟以前一样。
          unit: (event.unit || '').trim().slice(0, 6),
          specs: (event.specs || '').trim(),   // 成分与规格说明，买家端显著展示
          image: event.image || '',
          category: (event.category || '').trim(),
          available: event.available !== false,
          updated_at: new Date()
        }

        if (event.itemId) {
          // 只能改自己店里的商品
          const doc = await db.collection('shop_items').doc(event.itemId).get()
          if (!doc.data || doc.data.shop_id !== shop._id) {
            return { success: false, message: '没有权限' }
          }
          await db.collection('shop_items').doc(event.itemId).update({ data: data })
          return { success: true, itemId: event.itemId }
        }

        const res = await db.collection('shop_items').add({
          data: Object.assign({}, data, {
            shop_id: shop._id,
            owner: openid,
            created_at: new Date()
          })
        })
        return { success: true, itemId: res._id }
      }

      // 只切上架/售罄，比走 saveItem 轻，店长一天要点好几次
      case 'toggleItem': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const doc = await db.collection('shop_items').doc(event.itemId).get()
        if (!doc.data || doc.data.shop_id !== shop._id) {
          return { success: false, message: '没有权限' }
        }

        await db.collection('shop_items').doc(event.itemId).update({
          data: { available: !!event.available, updated_at: new Date() }
        })
        return { success: true }
      }

      case 'deleteItem': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const doc = await db.collection('shop_items').doc(event.itemId).get()
        if (!doc.data || doc.data.shop_id !== shop._id) {
          return { success: false, message: '没有权限' }
        }

        await db.collection('shop_items').doc(event.itemId).remove()
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('shopManage 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
