const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 网页版（minni-web，部署在 Vercel）的唯一数据源。走「HTTP 访问服务」，不经过小程序。
//
// 网页版只能浏览：下单、发布、留言、联系人都要回小程序。所以这里只读、只给公开字段，
// 而且是白名单——每个板块下发哪些字段在 FIELDS 里一个个列出来，新加的字段默认不出去。
// 刻意不下发的：
//   - 所有联系方式（seller_wechat / contact_wechat / 店长微信 / 邮箱）。网页是公开的，
//     会被搜索引擎收录，小程序里至少还隔着一层微信登录和学校邮箱验证
//   - 发布者的昵称、头像、_openid
//   - 审核中、没通过的帖子（只给已公开的和已结束的）
//
// 调用方只有 Vercel 的服务器，浏览器不直接调（不用处理跨域，结果还能在美国缓存）。
// 请求头 x-web-key 必须等于云函数环境变量 WEB_KEY；没配 WEB_KEY 时一律拒绝，
// 免得忘了配就成了谁都能刷的公开接口。
//
// 参数从查询串来：?action=list&type=item&kind=sell&skip=0&q=…
// 在云端测试面板里直接传 { action, type, … } 也行，见 paramsOf。

const PAGE_SIZE = 20
const URL_MAX_AGE = 2 * 24 * 3600   // 图片临时链接的有效期。网站最多缓存几分钟，留足余量

// 每个板块：集合、列表里算「在架」的状态、两面的 kind、列表和详情各下发哪些字段
const TYPES = {
  item: {
    collection: 'secondhand_items',
    live: 'on_sale',
    kinds: ['sell', 'want'],
    list: ['title', 'price', 'thumb', 'images', 'pickup_spot', 'description', 'kind', 'created_at'],
    detail: ['title', 'price', 'images', 'pickup_spot', 'description', 'kind', 'expire_date', 'created_at']
  },
  sublet: {
    collection: 'sublet_items',
    live: 'on_sale',
    kinds: ['offer', 'seek'],
    list: ['title', 'rent', 'rent_min', 'rent_max', 'address', 'room_type', 'thumb', 'images', 'start_date', 'description', 'kind', 'created_at'],
    detail: ['title', 'rent', 'rent_min', 'rent_max', 'address', 'room_type', 'images', 'start_date', 'end_date',
      'deposit', 'furnished', 'utilities', 'roommate_info', 'description', 'kind', 'created_at']
  },
  task: {
    collection: 'task_items',
    live: 'open',
    kinds: null,
    list: ['title', 'reward', 'thumb', 'images', 'deadline', 'description', 'created_at'],
    detail: ['title', 'reward', 'images', 'deadline', 'location', 'description', 'created_at']
  },
  group: {
    collection: 'group_items',
    live: 'open',
    kinds: ['buddy', 'club'],
    list: ['title', 'kind', 'thumb', 'images', 'event_date', 'location', 'description', 'created_at'],
    detail: ['title', 'kind', 'images', 'event_date', 'location', 'description', 'created_at']
  }
}

// 和小程序 utils/kinds.js 的 CLOSED_STATUS 一致：已结束的帖子详情页还能打开（群里的旧链接），列表里没有
const CLOSED_STATUS = ['sold', 'rented', 'done', 'expired']

const DESCRIPTION_PREVIEW = 80   // 列表只要一行摘要，整段描述留给详情页

function paramsOf(event) {
  if (event && event.httpMethod) return Object.assign({}, event.queryStringParameters)
  return event || {}
}

function headerOf(event, name) {
  const headers = (event && event.headers) || {}
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : ''
}

function reply(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data)
  }
}

function pick(doc, fields) {
  const out = { _id: doc._id }
  fields.forEach(f => {
    if (doc[f] !== undefined) out[f] = doc[f]
  })
  return out
}

// 和 market.js 一样：关键词会当正则送进数据库，特殊字符先转义
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 把一批文档里的 cloud:// 图片统一换成 https 链接。getTempFileURL 一次最多 50 个，分批并发
async function resolveImages(docs) {
  const ids = new Set()
  docs.forEach(d => {
    if (d.thumb) ids.add(d.thumb)
    ;(d.images || []).forEach(i => ids.add(i))
    if (d.logo) ids.add(d.logo)
    if (d.image) ids.add(d.image)
  })
  const list = [...ids].filter(id => typeof id === 'string' && id.startsWith('cloud://'))
  const map = {}
  const batches = []
  for (let i = 0; i < list.length; i += 50) batches.push(list.slice(i, i + 50))
  await Promise.all(batches.map(async batch => {
    const res = await cloud.getTempFileURL({ fileList: batch.map(id => ({ fileID: id, maxAge: URL_MAX_AGE })) })
    res.fileList.forEach(f => {
      if (f.status === 0) map[f.fileID] = f.tempFileURL
    })
  }))
  const url = id => (id && map[id]) || (id && !String(id).startsWith('cloud://') ? id : '')
  docs.forEach(d => {
    if (d.thumb !== undefined) d.thumb = url(d.thumb)
    if (d.images) d.images = d.images.map(url).filter(Boolean)
    if (d.logo !== undefined) d.logo = url(d.logo)
    if (d.image !== undefined) d.image = url(d.image)
  })
  return docs
}

// 列表卡片只要一张图：有缩略图用缩略图，老帖子没有就退回首图
function listShape(doc, cfg) {
  const out = pick(doc, cfg.list)
  if (!out.thumb && out.images && out.images.length) out.thumb = out.images[0]
  delete out.images
  if (out.description && out.description.length > DESCRIPTION_PREVIEW) {
    out.description = out.description.slice(0, DESCRIPTION_PREVIEW) + '…'
  }
  return out
}

async function list(p) {
  const cfg = TYPES[p.type]
  if (!cfg) return reply(400, { success: false, message: '参数不对' })
  const where = { status: cfg.live }
  if (cfg.kinds) where.kind = cfg.kinds.indexOf(p.kind) !== -1 ? p.kind : cfg.kinds[0]
  if (p.q) where.title = db.RegExp({ regexp: escapeRegExp(String(p.q).slice(0, 40)), options: 'i' })
  const skip = Math.max(0, Math.min(1000, Number(p.skip) || 0))

  const res = await db.collection(cfg.collection)
    .where(where)
    .orderBy('created_at', 'desc')
    .skip(skip)
    .limit(PAGE_SIZE)
    .get()
    .catch(() => ({ data: [] }))
  const items = await resolveImages(res.data.map(d => listShape(d, cfg)))
  return reply(200, { success: true, items: items, noMore: res.data.length < PAGE_SIZE })
}

async function detail(p) {
  const cfg = TYPES[p.type]
  if (!cfg || !p.id) return reply(400, { success: false, message: '参数不对' })
  let doc
  try {
    doc = (await db.collection(cfg.collection).doc(String(p.id)).get()).data
  } catch (e) {
    doc = null
  }
  // 审核中、没通过的、被管理员关掉的都当不存在。小程序里发布者自己能看，网页上没有「自己」
  if (!doc || (doc.status !== cfg.live && CLOSED_STATUS.indexOf(doc.status) === -1)) {
    return reply(404, { success: false, message: '内容不存在' })
  }
  const item = pick(doc, cfg.detail)
  item.status = doc.status
  await resolveImages([item])
  return reply(200, { success: true, item: item })
}

// 一起拼团复用 shopBrowse：场次能不能下单、几单了、几点到，逻辑都在那边，别再抄一份。
// 从这里调过去没有 OPENID，「我的拼团」和订阅状态自然是空的
async function browse(data) {
  const res = await cloud.callFunction({ name: 'shopBrowse', data: data })
  return res.result || { success: false }
}

async function shops() {
  const r = await browse({ action: 'list' })
  if (!r.success) return reply(502, { success: false, message: '读取失败' })
  const sessions = r.sessions.map(s => ({
    _id: s._id,
    shop_id: s.shop_id,
    shop_name: s.shop_name,
    logo: s.logo,
    slogan: s.slogan,
    date: s.date,
    depart_time: s.depart_time,
    cutoff_at: s.cutoff_at,
    min_orders: s.min_orders,
    count: s.count,
    points: s.points
  }))
  const idle = r.shops.map(s => pick(s, ['name', 'logo', 'description']))
  await resolveImages(sessions.concat(idle))
  return reply(200, { success: true, now: r.now, sessions: sessions, shops: idle })
}

async function shop(p) {
  if (!p.id) return reply(400, { success: false, message: '参数不对' })
  const r = await browse({ action: 'detail', shopId: String(p.id) })
  if (!r.success) return reply(404, { success: false, message: '店铺不存在' })
  // contact_wechat、营业执照这些不给网页
  const info = pick(r.shop, ['name', 'logo', 'description', 'slogan', 'min_order'])
  const items = r.items.map(i => pick(i, ['name', 'price', 'unit', 'description', 'specs', 'image', 'category', 'available', 'sold']))
  const sessions = r.sessions.map(s => pick(s, ['date', 'depart_time', 'cutoff_at', 'min_orders', 'count', 'points']))
  await resolveImages([info].concat(items))
  return reply(200, { success: true, now: r.now, shop: info, items: items, sessions: sessions })
}

// 首页：各板块在架几条 + 二手最新几件
async function home() {
  const counts = await Promise.all(Object.keys(TYPES).map(async type => {
    const cfg = TYPES[type]
    // 集合还没建（比如还没人发过群组）时当 0 条
    const res = await db.collection(cfg.collection).where({ status: cfg.live }).count()
      .catch(() => ({ total: 0 }))
    return [type, res.total]
  }))
  const latest = await db.collection('secondhand_items')
    .where({ status: 'on_sale', kind: 'sell' })
    .orderBy('created_at', 'desc')
    .limit(8)
    .get()
  const items = await resolveImages(latest.data.map(d => listShape(d, TYPES.item)))
  return reply(200, { success: true, counts: Object.fromEntries(counts), latest: items })
}

const ACTIONS = { home: home, list: list, detail: detail, shops: shops, shop: shop }

exports.main = async (event) => {
  const key = process.env.WEB_KEY
  // 云端测试面板直接调（没有 httpMethod）时不校验，方便调试；那条路只有登录控制台的人能走
  if (event && event.httpMethod && (!key || headerOf(event, 'x-web-key') !== key)) {
    return reply(403, { success: false, message: 'forbidden' })
  }
  const p = paramsOf(event)
  const fn = ACTIONS[p.action]
  if (!fn) return reply(400, { success: false, message: '未知操作' })
  try {
    return await fn(p)
  } catch (err) {
    console.error('webFeed 失败：', p.action, err)
    return reply(500, { success: false, message: '读取失败' })
  }
}
