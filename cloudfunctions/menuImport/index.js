const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 从网页导入菜单。几十道菜在手机上一个个录，很多老板会直接放弃；网页上贴链接、贴文字或拍照，
// AI 整理成表格，商家核对后回小程序一次上架。
//
// 流程和「在电脑上输入电视上的码」一样（device flow）：
//   1. 小程序「商品管理 → 从网页导入」：start 生成导入码，绑定这家店，30 分钟有效
//   2. minnepal.com/import 输入导入码：check → 每次调 AI 前 useParse 记一次（防刷 AI 额度）→ submit 交回整理好的商品
//   3. 小程序那页一直在 poll，收到后列出来，商家勾选、过内容审核，commit 写进 shop_items
//
// 为什么最后一步必须回小程序：店铺绑在店长自己的微信上，商品要由店长本人发布、本人负责，
// 也要照常过内容审核（审核接口只能从小程序端触发）。网页端只能往「待确认」里放东西，写不进店里。
//
// 同一个云函数两种调法：
//   - 小程序 callFunction（有 OPENID）：start / poll / commit
//   - 网页经 HTTP 访问服务（有 httpMethod）：check / useParse / submit，请求头 x-web-key 要等于环境变量 WEB_KEY，
//     和 webFeed 用同一个值。没配 WEB_KEY 一律拒绝
// 参数：小程序直接传对象；HTTP 用 POST，body 是 JSON。

const CODE_TTL_MS = 30 * 60 * 1000
const MAX_PARSES = 5          // 一个导入码最多让 AI 整理几次
const MAX_ITEMS = 150         // 一次导入最多多少件
const SHOP_ITEM_LIMIT = 200   // 和 shopManage listItems 的 limit 一致，超过了商品管理页显示不全
// 去掉 0/O/1/I/L 这些容易看错的字，6 位约 7 亿种组合
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

let collectionReady = false
async function ensureCollection() {
  if (collectionReady) return
  try {
    await db.createCollection('menu_imports')
  } catch (e) { /* 已经存在 */ }
  collectionReady = true
}

function newCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return s
}

function normCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

// 网页交回来的东西一律当不可信输入，逐个字段收窄
function cleanItems(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, MAX_ITEMS).map(i => {
    const price = Number(i && i.price)
    return {
      name: str(i && i.name, 40),
      price: price >= 0 && price < 10000 ? Math.round(price * 100) / 100 : null,
      unit: str(i && i.unit, 6),
      description: str(i && i.description, 200),
      category: str(i && i.category, 12),
      restricted: !!(i && i.restricted)
    }
  }).filter(i => i.name)
}

async function getMyShop(openid) {
  if (!openid) return null
  const res = await db.collection('shops').where({ owner: openid, takedown: _.neq(true) }).limit(1).get()
  return res.data[0] || null
}

async function findActive(code) {
  if (code.length !== 6) return null
  const res = await db.collection('menu_imports')
    .where({ code: code, expires_at: _.gt(Date.now()) })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return res.data[0] || null
}

function reply(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data)
  }
}

function headerOf(event, name) {
  const headers = (event && event.headers) || {}
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : ''
}

function bodyOf(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body
    return JSON.parse(raw || '{}')
  } catch (e) {
    return {}
  }
}

// ---- 网页端 ----

async function web(p) {
  const code = normCode(p.code)
  const doc = await findActive(code)
  // 交过一次就锁定：小程序那边收到后停止轮询，商家可能正在核对，再改会对不上
  if (!doc || doc.status !== 'waiting') return reply(404, { success: false, message: '导入码不对、已过期或已经提交过' })

  switch (p.action) {
    case 'check':
      return reply(200, { success: true, shopName: doc.shop_name, parsesLeft: MAX_PARSES - (doc.parses || 0) })

    // 条件更新，并发点几次也不会超过上限
    case 'useParse': {
      const r = await db.collection('menu_imports')
        .where({ _id: doc._id, parses: _.lt(MAX_PARSES) })
        .update({ data: { parses: _.inc(1) } })
      if (!r.stats.updated) return reply(429, { success: false, message: '这个导入码的整理次数用完了，请在小程序里重新生成' })
      return reply(200, { success: true })
    }

    case 'submit': {
      const items = cleanItems(p.items)
      if (!items.length) return reply(400, { success: false, message: '没有可导入的商品' })
      await db.collection('menu_imports').doc(doc._id).update({
        data: { items: _.set(items), status: 'ready', submitted_at: Date.now() }
      })
      return reply(200, { success: true, count: items.length })
    }

    default:
      return reply(400, { success: false, message: '未知操作' })
  }
}

// ---- 小程序端 ----

async function app(event, openid) {
  switch (event.action) {
    case 'start': {
      const shop = await getMyShop(openid)
      if (!shop) return { success: false, message: '你还没有小店' }
      // 撞码概率极低，撞了换一个
      let code = newCode()
      for (let i = 0; i < 5 && (await findActive(code)); i++) code = newCode()
      const now = Date.now()
      const res = await db.collection('menu_imports').add({
        data: {
          code: code,
          shop_id: shop._id,
          shop_name: shop.name || '',
          owner: openid,
          status: 'waiting',
          items: [],
          parses: 0,
          created_at: now,
          expires_at: now + CODE_TTL_MS
        }
      })
      return { success: true, importId: res._id, code: code, expiresAt: now + CODE_TTL_MS }
    }

    case 'poll': {
      const doc = await db.collection('menu_imports').doc(String(event.importId)).get().then(r => r.data, () => null)
      if (!doc || doc.owner !== openid) return { success: false, message: '导入记录不存在' }
      return {
        success: true,
        status: doc.status,
        expired: doc.status === 'waiting' && doc.expires_at < Date.now(),
        items: doc.status === 'ready' ? doc.items : []
      }
    }

    // 只收下标：商品内容以库里网页交回来的那份为准，前端只决定要哪几件、价格改成多少
    case 'commit': {
      const doc = await db.collection('menu_imports').doc(String(event.importId)).get().then(r => r.data, () => null)
      if (!doc || doc.owner !== openid) return { success: false, message: '导入记录不存在' }
      if (doc.status !== 'ready') return { success: false, message: '这批商品已经导入过了' }
      const shop = await getMyShop(openid)
      if (!shop || shop._id !== doc.shop_id) return { success: false, message: '没有权限' }

      const picks = Array.isArray(event.picks) ? event.picks : []
      const chosen = []
      picks.forEach(p => {
        const item = doc.items[Number(p && p.index)]
        if (!item || item.restricted) return    // 酒类等禁售的，前端改了也不收
        const price = Number(p.price)
        if (!(price >= 0)) return
        chosen.push(Object.assign({}, item, { price: Math.round(price * 100) / 100 }))
      })
      if (!chosen.length) return { success: false, message: '没有选中商品' }

      const existing = await db.collection('shop_items').where({ shop_id: shop._id }).count()
      if (existing.total + chosen.length > SHOP_ITEM_LIMIT) {
        return { success: false, message: '店里最多 ' + SHOP_ITEM_LIMIT + ' 件商品，这次最多还能导入 ' + Math.max(0, SHOP_ITEM_LIMIT - existing.total) + ' 件' }
      }

      // 先占住这批，重复点「导入」不会导两遍
      const lock = await db.collection('menu_imports').where({ _id: doc._id, status: 'ready' })
        .update({ data: { status: 'done', committed_at: Date.now() } })
      if (!lock.stats.updated) return { success: false, message: '这批商品已经导入过了' }

      const now = new Date()
      // 和 shopManage saveItem 写的字段一致。商家在确认页已经逐件看过、改过价，直接上架；
      // 没有图，海报上是一行字，商家之后在商品管理里补。一批 20 条，别一下并发 150 个写入
      const docs = chosen.map((i, n) => ({
        name: i.name,
        price: i.price,
        description: i.description,
        unit: i.unit,
        specs: '',
        image: '',
        category: i.category,
        available: true,
        shop_id: shop._id,
        owner: openid,
        imported: true,
        // 按菜单顺序排：商品管理按 created_at 升序
        created_at: new Date(now.getTime() + n),
        updated_at: now
      }))
      for (let k = 0; k < docs.length; k += 20) {
        await Promise.all(docs.slice(k, k + 20).map(d => db.collection('shop_items').add({ data: d })))
      }
      // 菜单里有分类的话，顺手打开分类显示
      if (chosen.some(i => i.category) && shop.use_category !== true) {
        await db.collection('shops').doc(shop._id).update({ data: { use_category: true, updated_at: now } })
      }
      return { success: true, count: chosen.length }
    }

    default:
      return { success: false, message: '未知操作' }
  }
}

exports.main = async (event) => {
  await ensureCollection()
  try {
    if (event && event.httpMethod) {
      const key = process.env.WEB_KEY
      if (!key || headerOf(event, 'x-web-key') !== key) return reply(403, { success: false, message: 'forbidden' })
      return await web(bodyOf(event))
    }
    return await app(event || {}, cloud.getWXContext().OPENID)
  } catch (err) {
    console.error('menuImport 失败：', event && event.action, err)
    return event && event.httpMethod
      ? reply(500, { success: false, message: '服务出错了' })
      : { success: false, message: '服务出错了，请重试' }
  }
}
