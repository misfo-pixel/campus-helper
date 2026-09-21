const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 店长自助管理：店铺资料 + 商品。
//
// 这些 action 合在一个云函数里，是因为它们全都要先过同一道
// 「这家店到底是不是你的」校验。拆成七个函数就得把那段逻辑抄七遍，
// 而且每加一个 action 你就得在开发者工具里多点一次部署。
//
// 注意：云函数写库不会自动带 _openid（那是小程序端 add 才有的），
// 所以店铺和商品的归属都用显式的 owner 字段存。

// 店长自己能切的只有两态：营业中 / 打烊。
// closed 不在其中——它是系统态，表示「还轮不到营业」：新店待审、审核被拒、
// 改了关键信息要重审。三种情况都由别处写入，店长在工作台里选不到它。
// 显示上 closed 和 paused 都是「打烊」，所以店长看不出区别，切一次就收敛成 paused。
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
// 纯线上服务没有场次这回事，不拦。其余三种方式都得有个有效场次——
// 配送队那支也一样，截单时刻是店长自己定的，不归队伍管了。
function slotBlocker(shop) {
  if (shop.needs_delivery === false) return null

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
// 过去的日期照样存下来——场次一过期就拒绝保存的话，店长连改商品都改不了。
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
// 自己送就存在这里，外包就用配送队的那份。店长先选谁送，再决定填不填。
// 配送这块是两个正交的问题，分两层存：
//   exact_address  送到买家地址（true）还是买家过来取（false）
//   delivery_mode  只有送上门才有意义——self 自己送 / team 找配送队
//
// 2026-09-20：team 模式又要指明是哪一支队了，存在 delivery_team_id 上。
// 这不是回到老的 'outsourced'——那个值意味着整套派单对账都绑在队伍上；
// 现在绑定只解决一个问题：送达前该通知谁。派单和结账仍然不归平台。
//
// 'outsourced' 和 'task'（撤掉的委托送）都是历史值，normalizeMode 把
// 'outsourced' 收敛成 'team'，老数据的 delivery_team_id 正好能接着用。
const DELIVERY_MODES = ['self', 'team']

function normalizeMode(value) {
  return (value === 'outsourced' || value === 'team') ? 'team' : 'self'
}

function pickShopFields(event) {
  // 老店铺库里没有这个字段，读出来是 undefined。默认按「有线下交付」算，
  // 否则一次保存就会把已经配置好的服务地点和场次清空。
  const needsDelivery = event.needs_delivery !== false

  // 先问送不送上门，再问谁送。客户自取时「谁来送」不存在，mode 归 self 占位。
  const exact = needsDelivery && event.exact_address === true
  const mode = exact ? normalizeMode(event.delivery_mode) : 'self'

  return {
    name: (event.name || '').trim(),
    description: (event.description || '').trim(),
    logo: event.logo || '',
    min_order: Number(event.min_order) || 0,
    business_hours: (event.business_hours || '').trim(),

    // 店长自己写给买家看的一段话（取货约定、备注怎么填、多久回复…）。
    // 平台不替店长生成这段，也不审它——写什么、写不写都由店长决定。
    order_notice: (event.order_notice || '').trim().slice(0, 300),
    contact_wechat: (event.contact_wechat || '').trim(),

    // 下单时要不要买家补充说明（尺寸、颜色、口味、参考图这类）。
    // 默认关闭：多数店卖的是标品，硬加一步只会挡住下单。
    // note_hint 是店长自己写的提示语，直接当买家那个输入框的 placeholder。
    note_required: event.note_required === true,
    note_hint: (event.note_hint || '').trim().slice(0, 60),

    // 有没有线下交付。关掉的是纯线上服务（辅导、代写、设计这类），
    // 这种既没有地点也没有场次，下面几项一律清空。
    //
    // 注意：到店自取【属于】要线下交付——它就是「不送到精确地址」那一支，
    // 照样需要服务地点和时间，只是配送费填 0。
    needs_delivery: needsDelivery,
    delivery_mode: needsDelivery ? mode : 'self',

    // 送到买家填的地址，还是买家到固定点位来取
    exact_address: needsDelivery ? exact : false,

    // 绑定的配送队。只有「送上门 + 找配送队」这一种组合才存，
    // 其余情况一律清空——留着一个不生效的绑定，下次切回来会静默复活。
    delivery_team_id: mode === 'team' ? String(event.delivery_team_id || '') : '',

    // 送上门没有「按点位计价」这回事，改成一口价
    flat_delivery_fee: (needsDelivery && exact)
      ? Math.round(Math.max(0, Number(event.flat_delivery_fee) || 0) * 100) / 100
      : 0,

    // 资质凭证选填，不作为入驻门槛。平台不核实、也没有能力核实，
    // 传了就留档——出事时这是责任在谁的直接证据。
    license_image: event.license_image || '',

    // 点位只有「客户自取」才用得上；服务时间三种方式都要（得有个截单时刻）
    pickup_points: (needsDelivery && !exact) ? cleanPickupPoints(event.pickup_points) : [],
    batches: needsDelivery ? cleanBatches(event.batches) : []
  }
}

function validateShop(fields) {
  if (!fields.name) return '请填写店铺名称'
  if (!fields.contact_wechat) return '请填写联系微信'
  if (fields.needs_delivery) {
    if (!fields.batches.length) {
      return '要设一个服务时间：日期 + 截单时间 + 送达时间'
    }
    if (!fields.exact_address && !fields.pickup_points.length) {
      return '客户自取的话，至少要设一个服务地点'
    }
    // 「找配送队」不再是一个空标记，得指明是哪一支——
    // 送达前要通知谁、买家问起来谁在送，都得有这个答案
    if (fields.delivery_mode === 'team' && !fields.delivery_team_id) {
      return '请选择一支配送队'
    }
  }
  return null
}

// 队伍是否还能被绑定。放在这里而不是 validateShop 里，是因为它要查库——
// validateShop 保持纯函数，只管「填没填」，能不能用是另一回事。
//
// 只拦「这支队不存在」。时间对不对得上不在这儿拦：队长随时会改自己的
// 可配送时段，服务端一卡，店长连改个营业时间都保存不了，而且他可能早就在
// 微信里和队长约好了那一趟。界面上该置灰的已经置灰、该警告的已经警告，
// 真要绑一支时间对不上的，那是他们俩的事。
async function checkTeamBindable(teamId) {
  if (!teamId) return null
  try {
    const doc = await db.collection('delivery_teams').doc(teamId).get()
    if (!doc.data) return '这支配送队暂时不可用，请重新选择'
    return null
  } catch (e) {
    console.warn('校验配送队失败：', teamId, e)
    return '这支配送队暂时不可用，请重新选择'
  }
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
          return { success: false, message: '请先阅读并同意《店长责任告知书》' }
        }

        const fields = pickShopFields(event)
        const invalid = validateShop(fields)
        if (invalid) return { success: false, message: invalid }

        const badTeam = await checkTeamBindable(fields.delivery_team_id)
        if (badTeam) return { success: false, message: badTeam }

        const res = await db.collection('shops').add({
          data: Object.assign({}, fields, {
            owner: openid,
            // 新店默认打烊。平台不做事前审核，提交即开店，但也不该在店长
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

        const badTeam = await checkTeamBindable(fields.delivery_team_id)
        if (badTeam) return { success: false, message: badTeam }

        await db.collection('shops').doc(shop._id).update({
          data: Object.assign({}, fields, { updated_at: new Date() })
        })
        return { success: true }
      }

      // 营业中 / 打烊
      case 'setStatus': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        // 被举报下架的店，店长自己切不回营业中——否则下架等于没下架
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
          unit: (event.unit || '').trim().slice(0, 4),
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
