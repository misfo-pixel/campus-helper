const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 商家自助管理：店铺资料 + 菜单。
//
// 这些 action 合在一个云函数里，是因为它们全都要先过同一道
// 「这家店到底是不是你的」校验。拆成七个函数就得把那段逻辑抄七遍，
// 而且每加一个 action 你就得在开发者工具里多点一次部署。
//
// 注意：云函数写库不会自动带 _openid（那是小程序端 add 才有的），
// 所以店铺和菜品的归属都用显式的 owner 字段存。

const SHOP_STATUS = ['open', 'paused', 'closed']

function cleanPickupPoints(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(p => p && String(p.name || '').trim())
    .map(p => ({
      name: String(p.name).trim(),
      address: String(p.address || '').trim(),
      fee: Math.max(0, Number(p.fee) || 0)
    }))
}

function cleanBatches(raw) {
  if (!Array.isArray(raw)) return []
  const isTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
  return raw
    .filter(b => b && b.label && isTime(b.cutoff) && isTime(b.deliver_time))
    .map(b => ({
      label: String(b.label).trim(),
      cutoff: b.cutoff,
      deliver_time: b.deliver_time
    }))
    .sort((a, b) => (a.cutoff < b.cutoff ? -1 : 1))
}

// 拿到自己的店。没有就返回 null，不算错误——新用户本来就没有店。
async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

// 配送方案（取餐点 + 批次时间）属于实际送货的那一方：
// 自己送就存在这里，外包就用配送队的那份。商家先选谁送，再决定填不填。
function pickShopFields(event) {
  const mode = event.delivery_mode === 'outsourced' ? 'outsourced' : 'self'
  return {
    name: (event.name || '').trim(),
    description: (event.description || '').trim(),
    logo: event.logo || '',
    category: event.category || '',
    min_order: Number(event.min_order) || 0,
    delivery_area: (event.delivery_area || '').trim(),
    business_hours: (event.business_hours || '').trim(),
    payment_note: (event.payment_note || '').trim(),
    contact_wechat: (event.contact_wechat || '').trim(),
    delivery_mode: mode,
    delivery_team_id: mode === 'outsourced' ? (event.delivery_team_id || '') : '',

    // 资质由商家自己声明并举证。平台不核实、也没有能力核实，
    // 但要把这个声明和凭证留下来——出事时这是责任在谁的直接证据。
    license_confirmed: event.license_confirmed === true,
    license_image: event.license_image || '',

    // 自送才用得上；外包时买家走的是配送队那份方案
    pickup_points: mode === 'self' ? cleanPickupPoints(event.pickup_points) : [],
    batches: mode === 'self' ? cleanBatches(event.batches) : []
  }
}

function validateShop(fields) {
  if (!fields.name) return '请填写店铺名称'
  if (!fields.contact_wechat) return '请填写联系微信'
  if (!fields.payment_note) return '请填写收款方式，买家要按这个付款给你'
  if (fields.delivery_mode === 'outsourced' && !fields.delivery_team_id) {
    return '请选择要外包给哪个配送队'
  }
  if (!fields.license_confirmed) {
    return '请确认你已取得当地要求的食品经营资质'
  }
  if (fields.delivery_mode === 'self') {
    if (!fields.pickup_points.length) return '自己送的话，至少要设一个取餐点'
    if (!fields.batches.length) return '自己送的话，至少要设一个配送批次'
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
            status: 'closed',          // 审核通过前先不营业
            audit_status: 'pending',
            audit_reason: '',
            agreed_at: new Date(),           // 同意告知书的时间
            license_confirmed_at: new Date(), // 声明持有资质的时间
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

        // 改过资料要重新审核，不然可以先用正经内容过审再改成别的
        const needReaudit = shop.audit_status === 'approved' && fields.name !== shop.name

        await db.collection('shops').doc(shop._id).update({
          data: Object.assign({}, fields, {
            updated_at: new Date()
          }, needReaudit ? { audit_status: 'pending', status: 'closed' } : {})
        })
        return { success: true, reaudit: needReaudit }
      }

      // 营业中 / 暂停接单 / 打烊
      case 'setStatus': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }
        if (shop.audit_status !== 'approved') {
          return { success: false, message: '店铺还在审核中，通过后才能营业' }
        }
        if (SHOP_STATUS.indexOf(event.status) === -1) {
          return { success: false, message: '状态不合法' }
        }

        await db.collection('shops').doc(shop._id).update({
          data: { status: event.status, updated_at: new Date() }
        })
        return { success: true }
      }

      // ---- 菜单 ----

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

      // 新增或修改菜品。带 itemId 就是改，不带就是加。
      case 'saveItem': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        const name = (event.name || '').trim()
        const price = Number(event.price)
        if (!name) return { success: false, message: '请填写菜品名称' }
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
          // 只能改自己店里的菜
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

      // 把老外卖模块的 menu_items 导进当前店铺的菜单。
      // 老表字段是 name + price_after_tax，跟新的 shop_items 对不上，所以要映射一遍。
      // 按菜名去重，重复跑不会导出两份。
      case 'importLegacyMenu': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有店铺' }

        let legacy
        try {
          legacy = await db.collection('menu_items').limit(500).get()
        } catch (e) {
          console.error('读取 menu_items 失败：', e)
          return { success: false, message: '找不到旧菜单表 menu_items' }
        }
        if (!legacy.data.length) {
          return { success: false, message: '旧菜单表是空的' }
        }

        const existing = await db.collection('shop_items')
          .where({ shop_id: shop._id })
          .field({ name: true })
          .limit(500)
          .get()
        const taken = new Set(existing.data.map(i => i.name))

        let imported = 0
        let skipped = 0
        for (const old of legacy.data) {
          const name = String(old.name || '').trim()
          if (!name) { skipped++; continue }
          if (taken.has(name)) { skipped++; continue }

          // 老数据里价格可能叫 price_after_tax，也可能就叫 price
          const price = Number(old.price_after_tax != null ? old.price_after_tax : old.price) || 0

          await db.collection('shop_items').add({
            data: {
              shop_id: shop._id,
              owner: openid,
              name: name,
              price: price,
              description: old.description || '',
              allergens: old.allergens || '',
              image: old.image || old.image_url || '',
              category: old.category || '',
              available: true,
              created_at: new Date(),
              updated_at: new Date()
            }
          })
          taken.add(name)
          imported++
        }

        return {
          success: true,
          imported: imported,
          skipped: skipped,
          total: legacy.data.length,
          // 万一字段名跟我猜的不一样，把源数据的字段列出来方便对照
          sourceFields: Object.keys(legacy.data[0] || {})
        }
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
