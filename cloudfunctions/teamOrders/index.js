const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 配送队的工作台：看批次、领活、取货、送达。
//
// 领活的单位是「批次 × 店长」——一个人跑一趟，去一家店把这一批取了，
// 再拉到服务地点发给等着的人。按单领没意义（没人会为一单专门跑一趟），
// 按整批领又不对（一批里可能有好几家店的货）。
//
// 配送员推进状态时会顺带把店长那边的订单状态也改掉，
// 这样店长外包出去之后就真的不用再管了 —— 这才叫外包。

const VISIBLE_STATUS = ['accepted', 'delivering']

async function getMyTeamId(openid) {
  const m = await db.collection('team_members').where({ openid: openid }).limit(1).get()
  return m.data.length ? m.data[0].team_id : null
}

// 一次把这个队所有在途的单捞出来。校园场景单量小，够用而且省得分页。
async function loadLiveOrders(teamId) {
  const res = await db.collection('shop_orders')
    .where({
      delivery_team_id: teamId,
      status: _.in(VISIBLE_STATUS),
      delivery_status: _.in(['waiting', 'picked'])
    })
    .orderBy('created_at', 'asc')
    .limit(500)
    .get()
  return res.data
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    const teamId = await getMyTeamId(openid)
    if (!teamId) return { success: false, message: '你还不在任何配送队里' }

    switch (action) {

      // 批次列表：按「批次 → 店长」两层分组
      case 'groups': {
        const orders = await loadLiveOrders(teamId)

        const batchMap = {}
        orders.forEach(o => {
          if (!batchMap[o.batch_key]) {
            batchMap[o.batch_key] = {
              batch_key: o.batch_key,
              batch_label: o.batch_label,
              batch_date: o.batch_date,
              deliver_time: o.deliver_time,
              shops: {}
            }
          }
          const shops = batchMap[o.batch_key].shops
          if (!shops[o.shop_id]) {
            shops[o.shop_id] = {
              shop_id: o.shop_id,
              shop_name: o.shop_name,
              count: 0,
              deliverer: o.deliverer || '',
              deliverer_nickname: o.deliverer_nickname || '',
              picked: 0
            }
          }
          shops[o.shop_id].count++
          if (o.delivery_status === 'picked') shops[o.shop_id].picked++
        })

        const groups = Object.keys(batchMap).map(k => {
          const b = batchMap[k]
          return Object.assign({}, b, {
            shops: Object.keys(b.shops).map(sid => b.shops[sid])
          })
        }).sort((a, b) => (a.batch_key < b.batch_key ? -1 : 1))

        return { success: true, groups: groups, me: openid }
      }

      // 汇总清单：给店长报单的取货清单 + 按服务地点分组的交付清单。
      // 这两张表就是老配送队 summary 页做的事，批次配送需要的正是它。
      case 'manifest': {
        const res = await db.collection('shop_orders')
          .where({
            delivery_team_id: teamId,
            batch_key: event.batch_key,
            shop_id: event.shop_id,
            status: _.in(VISIBLE_STATUS)
          })
          .limit(200)
          .get()

        const orders = res.data
        if (!orders.length) return { success: true, pickup: [], points: [], shopName: '' }

        // 取货清单：所有单的商品按名字合并计数，单位跟着名字走
        const productMap = {}
        orders.forEach(o => {
          (o.items || []).forEach(it => {
            if (!productMap[it.name]) productMap[it.name] = { count: 0, unit: it.unit || '' }
            productMap[it.name].count += it.count
          })
        })
        const pickup = Object.keys(productMap).map(name => ({
          name: name, count: productMap[name].count, unit: productMap[name].unit
        }))

        // 交付清单：按服务地点分组。买家到服务地点自取，配送员在点上按名字分发。
        const pointMap = {}
        orders.forEach(o => {
          const p = o.pickup_point || o.building || '未填服务地点'
          if (!pointMap[p]) pointMap[p] = { address: o.pickup_address || '', orders: [] }
          pointMap[p].orders.push({
            order_id: o._id,
            buyer_nickname: o.buyer_nickname || '买家',
            contact_wechat: o.contact_wechat || '',
            note: o.note || '',
            delivery_status: o.delivery_status,
            items: (o.items || []).map(it => it.name + '×' + it.count).join('、')
          })
        })
        const points = Object.keys(pointMap).sort().map(p => ({
          point: p,
          address: pointMap[p].address,
          orders: pointMap[p].orders
        }))

        return {
          success: true,
          shopName: orders[0].shop_name,
          batchLabel: orders[0].batch_label,
          deliverTime: orders[0].deliver_time,
          deliverer: orders[0].deliverer || '',
          pickup: pickup,
          points: points
        }
      }

      // 领活：把这个「批次 × 店长」的单都挂到自己名下
      case 'claim': {
        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取配送员昵称失败：', e)
        }

        const res = await db.collection('shop_orders')
          .where({
            delivery_team_id: teamId,
            batch_key: event.batch_key,
            shop_id: event.shop_id,
            status: _.in(VISIBLE_STATUS),
            deliverer: ''
          })
          .update({
            data: {
              deliverer: openid,
              deliverer_nickname: nickname,
              updated_at: new Date()
            }
          })

        if (res.stats.updated === 0) {
          return { success: false, message: '这批已经被别人领走了' }
        }
        return { success: true, claimed: res.stats.updated }
      }

      // 取到货了：整批标记 picked，同时把店长那边推进到「配送中」
      case 'markPicked': {
        const res = await db.collection('shop_orders')
          .where({
            delivery_team_id: teamId,
            batch_key: event.batch_key,
            shop_id: event.shop_id,
            deliverer: openid,
            delivery_status: 'waiting'
          })
          .update({
            data: {
              delivery_status: 'picked',
              status: 'delivering',
              updated_at: new Date()
            }
          })
        return { success: true, updated: res.stats.updated }
      }

      // 单个送达：配送和店长两条状态一起收尾
      case 'markDelivered': {
        const doc = await db.collection('shop_orders').doc(event.orderId).get()
        const order = doc.data
        if (!order || order.delivery_team_id !== teamId) {
          return { success: false, message: '订单不存在' }
        }
        if (order.deliverer && order.deliverer !== openid) {
          return { success: false, message: '这单是别人领的' }
        }

        await db.collection('shop_orders').doc(event.orderId).update({
          data: {
            delivery_status: 'delivered',
            status: 'completed',
            updated_at: new Date()
          }
        })

        // 这条路径直接把订单推成 completed，没走 shopOrders.updateStatus，
        // 所以买家的到货通知得在这里单独发一次，不然这一类单永远收不到。
        try {
          const first = (order.items || [])[0] || {}
          const more = (order.items || []).length > 1
            ? ' 等 ' + order.items.length + ' 件' : ''
          const pad = n => (n < 10 ? '0' + n : '' + n)
          const now = new Date()
          await cloud.callFunction({
            name: 'sendSubscribe',
            data: {
              tpl: 'orderProgress',
              toUser: order.buyer,
              page: 'pages/myshoporders/myshoporders',
              data: {
                status: '已送达',
                item: (first.name || '你的订单') + more,
                time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':00',
                tip: '到 ' + (order.pickup_point || '服务地点') + ' 取一下'
              }
            }
          })
        } catch (e) {
          console.warn('送达通知发送失败（不影响状态）：', e)
        }

        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('teamOrders 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
