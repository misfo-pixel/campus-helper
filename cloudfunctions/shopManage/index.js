const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 商家自助管理：店铺资料 + 商品。
//
// 这些 action 合在一个云函数里，是因为它们全都要先过同一道
// 「这家店到底是不是你的」校验。拆成七个函数就得把那段逻辑抄七遍，
// 而且每加一个 action 你就得在开发者工具里多点一次部署。
//
// 注意：云函数写库不会自动带 _openid（那是小程序端 add 才有的），
// 所以店铺和商品的归属都用显式的 owner 字段存。

// 商家自己能切的只有两态：营业中 / 打烊。
// closed 不在其中——它是系统态，表示「还轮不到营业」：新店待审、审核被拒、
// 改了关键信息要重审。三种情况都由别处写入，商家在工作台里选不到它。
// 显示上 closed 和 paused 都是「打烊」，所以商家看不出区别，切一次就收敛成 paused。
const SHOP_STATUS_SELECTABLE = ['open', 'paused']

// 场次截没截单要按明尼苏达当地时间判断。这段和 shopBrowse / buyerOrders /
// deliveryManage 里的是同一份——云函数之间没法共享代码，只能各存一份，
// 改的时候四处一起改。
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

// 开门营业的硬前提：得有一场买家真能约上的服务时间。
// 没有这道闸，工作台会出现「营业中」但买家点进店一个时段都选不出来的死局。
// 返回拦截理由，null = 可以开门。
//
// 外包给配送队的店走的是队伍那份方案，场次不归商家管，不拦他。
function slotBlocker(shop) {
  if (shop.delivery_mode === 'outsourced') return null

  const slot = (shop.batches || [])[0]
  if (!slot || !slot.date) {
    return '先在店铺设置里设一个服务时间（日期 + 截单时间 + 送达时间），才能开门营业'
  }

  const now = nowInTZ()
  if (slot.date < now.date) {
    return '服务时间还停在 ' + slot.date + '，先去店铺设置里改成今天或以后'
  }
  if (slot.date === now.date && now.minutes >= toMinutes(slot.cutoff)) {
    return '今天 ' + slot.cutoff + ' 已经截单了，先去店铺设置里把服务时间改到明天'
  }
  return null
}

function cleanPickupPoints(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(p => p && String(p.name || '').trim())
    .map(p => ({
      // 一句话就是服务地点（「Coffman 门口」），不再拆名称 + 具体位置两格。
      // 它同时是订单里引用的标识符，所以限长，别让它长成一段描述。
      name: String(p.name).trim().slice(0, 20),
      fee: Math.max(0, Number(p.fee) || 0)
    }))
}

// 场次每次只开一场，所以这里只认第一条。
// 结构保持数组：将来要恢复「上午班 / 下午班」两趟只需放开界面，不用迁移数据。
//
// 过去的日期照样存下来——场次一过期就拒绝保存的话，商家连改商品都改不了。
// 该不该给买家看，由 expandBatches 决定。
function cleanBatches(raw) {
  if (!Array.isArray(raw)) return []
  const isTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const b = raw[0]
  if (!b || !isDate(b.date) || !isTime(b.cutoff) || !isTime(b.deliver_time)) return []
  if (b.deliver_time <= b.cutoff) return []
  return [{ date: b.date, cutoff: b.cutoff, deliver_time: b.deliver_time }]
}

// 拿到自己的店。没有就返回 null，不算错误——新用户本来就没有店。
async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

// 配送方案（服务地点 + 服务时间）属于实际送货的那一方：
// 自己送就存在这里，外包就用配送队的那份。商家先选谁送，再决定填不填。
function pickShopFields(event) {
  const mode = event.delivery_mode === 'outsourced' ? 'outsourced' : 'self'
  return {
    name: (event.name || '').trim(),
    description: (event.description || '').trim(),
    logo: event.logo || '',
    category: event.category || '',
    min_order: Number(event.min_order) || 0,
    business_hours: (event.business_hours || '').trim(),
    contact_wechat: (event.contact_wechat || '').trim(),
    delivery_mode: mode,
    delivery_team_id: mode === 'outsourced' ? (event.delivery_team_id || '') : '',

    // 资质凭证选填，不作为入驻门槛。平台不核实、也没有能力核实，
    // 传了就留档——出事时这是责任在谁的直接证据。
    license_image: event.license_image || '',

    // 自送才用得上；外包时买家走的是配送队那份方案
    pickup_points: mode === 'self' ? cleanPickupPoints(event.pickup_points) : [],
    batches: mode === 'self' ? cleanBatches(event.batches) : []
  }
}

function validateShop(fields) {
  if (!fields.name) return '请填写店铺名称'
  if (!fields.contact_wechat) return '请填写联系微信'
  if (fields.delivery_mode === 'outsourced' && !fields.delivery_team_id) {
    return '请选择要外包给哪个配送队'
  }
  if (fields.delivery_mode === 'self') {
    if (!fields.pickup_points.length) return '自己送的话，至少要设一个服务地点'
    if (!fields.batches.length) return '自己送的话，要设一个服务时间：日期 + 截单时间 + 送达时间'
  }
  return null
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

      // 首次入驻。已经有店的话走 update，不允许一个人开两家
      case 'apply': {
        const existing = await getMyShop(openid)
        if (existing) return { success: false, message: '你已经有一家店了' }

        if (!event.agreed) {
          return { success: false, message: '请先阅读并同意《商家责任告知书》' }
        }

        const fields = pickShopFields(event)
        const invalid = validateShop(fields)
        if (invalid) return { success: false, message: invalid }

        const res = await db.collection('shops').add({
          data: Object.assign({}, fields, {
            owner: openid,
            // 新店默认打烊。平台不做事前审核，提交即开店，但也不该在商家
            // 还没上架商品时就把店推到买家面前——他自己在工作台点「营业中」。
            status: 'closed',
            agreed_at: new Date(),     // 同意告知书的时间
            created_at: new Date(),
            updated_at: new Date()
          })
        })
        return { success: true, shopId: res._id }
      }

      case 'update': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const fields = pickShopFields(event)
        const invalid = validateShop(fields)
        if (invalid) return { success: false, message: invalid }

        await db.collection('shops').doc(shop._id).update({
          data: Object.assign({}, fields, { updated_at: new Date() })
        })
        return { success: true }
      }

      // 营业中 / 打烊
      case 'setStatus': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        // 被举报下架的店，商家自己切不回营业中——否则下架等于没下架
        if (shop.takedown) {
          return { success: false, message: '店铺因违规被下架，如有异议请通过意见反馈联系我们' }
        }
        if (SHOP_STATUS_SELECTABLE.indexOf(event.status) === -1) {
          return { success: false, message: '状态不合法' }
        }

        // 打烊随时可以，开门要先过场次这一关
        if (event.status === 'open') {
          const blocked = slotBlocker(shop)
          if (blocked) return { success: false, message: blocked }
        }

        await db.collection('shops').doc(shop._id).update({
          data: { status: event.status, updated_at: new Date() }
        })
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
        return { success: true, items: res.data }
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
          allergens: (event.allergens || '').trim(),   // 过敏原，买家端要显著展示
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

      // 只切上架/售罄，比走 saveItem 轻，商家一天要点好几次
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
