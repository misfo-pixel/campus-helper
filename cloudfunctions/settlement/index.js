const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 店长 ←→ 配送队 的配送费对账。
//
// 平台不经手资金，所以这里唯一的作用是：让两边看到同一个数。
// 没有这份账，队长和老板每周各数一遍单，数不一样就开始扯皮；
// 有了它，微信里的对话从「我算 104 你算多少」变成「确认 104，转了」。
//
// 关键：金额一律按 delivery_fee_owed 算，不是 delivery_fee_charged。
// 店长将来搞「满 X 免配送费」时买家实付会变 0，但配送队该拿的一分不少。
//
// 状态机（钱在小程序外走，这里只记录双方的确认）：
//   pending  已生成账单，等店长转账
//   paid     店长说转了，等队伍确认收到
//   settled  队伍确认收到，这一笔结清
//
// 任一方都能发起，因为谁先想起来对账都行。

async function resolveActor(openid, as) {
  if (as === 'shop') {
    const r = await db.collection('shops').where({ owner: openid }).limit(1).get()
    if (!r.data.length) return null
    return { kind: 'shop', id: r.data[0]._id, name: r.data[0].name }
  }

  const m = await db.collection('team_members').where({ openid: openid }).limit(1).get()
  if (!m.data.length) return null
  const t = await db.collection('delivery_teams').doc(m.data[0].team_id).get()
  if (!t.data) return null
  return { kind: 'team', id: t.data._id, name: t.data.name, role: m.data[0].role }
}

// 还没打包进任何账单的、已完成的、确实欠钱的单
function unsettledWhere(actor) {
  const base = {
    status: 'completed',
    delivery_fee_owed: _.gt(0),
    settlement_id: _.in(['', null, undefined])
  }
  if (actor.kind === 'shop') base.shop_id = actor.id
  else base.delivery_team_id = actor.id
  return base
}

function sumOwed(orders) {
  return Math.round(orders.reduce((s, o) => s + (Number(o.delivery_fee_owed) || 0), 0) * 100) / 100
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action
  const as = event.as === 'shop' ? 'shop' : 'team'

  try {
    const actor = await resolveActor(openid, as)
    if (!actor) {
      return { success: false, message: as === 'shop' ? '你还没有店铺' : '你还不在任何配送队里' }
    }

    switch (action) {

      // 待结算汇总：店长看「我欠哪些队多少」，队伍看「哪些店长欠我多少」
      case 'summary': {
        const res = await db.collection('food_orders')
          .where(unsettledWhere(actor)).limit(1000).get()

        const groupKey = actor.kind === 'shop' ? 'delivery_team_id' : 'shop_id'
        const nameKey = actor.kind === 'shop' ? null : 'shop_name'

        const map = {}
        res.data.forEach(o => {
          const k = o[groupKey]
          if (!k) return
          if (!map[k]) map[k] = { id: k, name: nameKey ? o[nameKey] : '', count: 0, amount: 0, orders: [] }
          map[k].count++
          map[k].amount += Number(o.delivery_fee_owed) || 0
          map[k].orders.push(o)
        })

        // 店长视角要补队伍名（订单里只存了 team_id）
        if (actor.kind === 'shop') {
          const ids = Object.keys(map)
          if (ids.length) {
            const teams = await db.collection('delivery_teams')
              .where({ _id: _.in(ids) }).limit(50).get()
            teams.data.forEach(t => {
              if (map[t._id]) {
                map[t._id].name = t.name
                map[t._id].payment_note = t.payment_note
                map[t._id].contact_wechat = t.contact_wechat
              }
            })
          }
        }

        const groups = Object.keys(map).map(k => ({
          id: map[k].id,
          name: map[k].name || '（已删除）',
          count: map[k].count,
          amount: Math.round(map[k].amount * 100) / 100,
          payment_note: map[k].payment_note || '',
          contact_wechat: map[k].contact_wechat || ''
        }))

        return { success: true, actor: actor, groups: groups }
      }

      // 发起对账：把当前所有未结的单打包成一张账单
      case 'create': {
        if (actor.kind === 'team' && actor.role !== 'admin') {
          return { success: false, message: '只有队长能发起对账' }
        }

        const counterpartId = event.counterpartId
        if (!counterpartId) return { success: false, message: '缺少对方信息' }

        const where = unsettledWhere(actor)
        if (actor.kind === 'shop') where.delivery_team_id = counterpartId
        else where.shop_id = counterpartId

        const res = await db.collection('food_orders').where(where).limit(1000).get()
        if (!res.data.length) return { success: false, message: '没有待结算的订单' }

        const orders = res.data
        const amount = sumOwed(orders)
        const shopId = actor.kind === 'shop' ? actor.id : counterpartId
        const teamId = actor.kind === 'shop' ? counterpartId : actor.id

        const shopDoc = await db.collection('shops').doc(shopId).get()
        const teamDoc = await db.collection('delivery_teams').doc(teamId).get()

        const dates = orders.map(o => o.batch_date).filter(Boolean).sort()

        const bill = await db.collection('settlements').add({
          data: {
            shop_id: shopId,
            shop_name: (shopDoc.data && shopDoc.data.name) || '',
            team_id: teamId,
            team_name: (teamDoc.data && teamDoc.data.name) || '',
            team_payment_note: (teamDoc.data && teamDoc.data.payment_note) || '',
            team_wechat: (teamDoc.data && teamDoc.data.contact_wechat) || '',
            order_count: orders.length,
            amount: amount,
            period_from: dates[0] || '',
            period_to: dates[dates.length - 1] || '',
            status: 'pending',
            created_by: openid,
            created_by_kind: actor.kind,
            created_at: new Date()
          }
        })

        // 打上账单号就不会再被下一次对账重复计入
        await db.collection('food_orders')
          .where(where)
          .update({ data: { settlement_id: bill._id, updated_at: new Date() } })

        return { success: true, settlementId: bill._id, amount: amount, count: orders.length }
      }

      case 'list': {
        const where = actor.kind === 'shop' ? { shop_id: actor.id } : { team_id: actor.id }
        const res = await db.collection('settlements')
          .where(where).orderBy('created_at', 'desc').limit(50).get()
        return { success: true, actor: actor, settlements: res.data }
      }

      case 'detail': {
        const doc = await db.collection('settlements').doc(event.settlementId).get()
        const bill = doc.data
        if (!bill) return { success: false, message: '账单不存在' }
        if ((actor.kind === 'shop' && bill.shop_id !== actor.id) ||
            (actor.kind === 'team' && bill.team_id !== actor.id)) {
          return { success: false, message: '没有权限' }
        }

        const res = await db.collection('food_orders')
          .where({ settlement_id: bill._id })
          .orderBy('batch_date', 'asc')
          .limit(1000)
          .get()

        return {
          success: true,
          actor: actor,
          settlement: bill,
          orders: res.data.map(o => ({
            _id: o._id,
            batch_date: o.batch_date,
            batch_label: o.batch_label,
            pickup_point: o.pickup_point || o.building || '',
            fee: o.delivery_fee_owed
          }))
        }
      }

      // 店长：我转过去了
      case 'markPaid': {
        if (actor.kind !== 'shop') return { success: false, message: '只有店长能标记已转账' }

        const doc = await db.collection('settlements').doc(event.settlementId).get()
        const bill = doc.data
        if (!bill || bill.shop_id !== actor.id) return { success: false, message: '账单不存在' }
        if (bill.status !== 'pending') return { success: false, message: '这笔账单已经处理过了' }

        await db.collection('settlements').doc(bill._id).update({
          data: { status: 'paid', paid_at: new Date() }
        })
        return { success: true }
      }

      // 配送队：钱收到了，结清
      case 'confirm': {
        if (actor.kind !== 'team') return { success: false, message: '只有配送队能确认收款' }
        if (actor.role !== 'admin') return { success: false, message: '只有队长能确认收款' }

        const doc = await db.collection('settlements').doc(event.settlementId).get()
        const bill = doc.data
        if (!bill || bill.team_id !== actor.id) return { success: false, message: '账单不存在' }
        if (bill.status === 'settled') return { success: false, message: '这笔已经结清了' }

        await db.collection('settlements').doc(bill._id).update({
          data: { status: 'settled', settled_at: new Date() }
        })
        await db.collection('food_orders')
          .where({ settlement_id: bill._id })
          .update({ data: { settled: true, updated_at: new Date() } })

        return { success: true }
      }

      // 发错了可以撤回，订单退回待结算池
      case 'cancel': {
        const doc = await db.collection('settlements').doc(event.settlementId).get()
        const bill = doc.data
        if (!bill) return { success: false, message: '账单不存在' }
        if (bill.created_by !== openid) return { success: false, message: '只有发起方能撤回' }
        if (bill.status === 'settled') return { success: false, message: '已结清的账单不能撤回' }

        await db.collection('food_orders')
          .where({ settlement_id: bill._id })
          .update({ data: { settlement_id: '', updated_at: new Date() } })
        await db.collection('settlements').doc(bill._id).remove()

        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('settlement 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
