const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 店长 → 配送队的配送请求。
//
// 这是配送队体系精简后剩下的全部：一条请求 + 一条推送，队长自己微信联系店长。
//
// 原来那套（按「批次 × 店长」领活、取货清单、配送费三态对账）还在
// teamOrders / teammanifest / settlement 里，没删，但不再走了——
// 现阶段没有真实的配送队在跑，为一个不存在的角色维护一套工作流是负债。
// 等真有人组队了，那时候照着他们实际怎么干再做，比现在猜准得多。
//
// 平台在这里做的事只有两件：把请求记下来、给队长发个提醒。
// 送不送、多少钱、怎么结，全是他们俩的事。

async function getMyShop(openid) {
  const res = await db.collection('shops').where({ owner: openid }).limit(1).get()
  return res.data[0] || null
}

// 我是不是某支队的人。和 deliveryManage 里那份保持一致：
// 队长在 delivery_teams.admin 上，队员在 team_members 表里。
async function getMyTeam(openid) {
  const asAdmin = await db.collection('delivery_teams')
    .where({ admin: openid }).limit(1).get()
  if (asAdmin.data.length) return asAdmin.data[0]

  const asMember = await db.collection('team_members')
    .where({ openid: openid }).limit(1).get()
  if (!asMember.data.length) return null

  try {
    const t = await db.collection('delivery_teams').doc(asMember.data[0].team_id).get()
    return t.data || null
  } catch (e) {
    return null
  }
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请先登录' }

  try {
    switch (event.action) {

      // 店长发起
      case 'create': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有小店' }

        const note = String(event.note || '').trim().slice(0, 300)
        if (!note) return { success: false, message: '说清楚几单、什么时候、送到哪' }
        if (!event.teamId) return { success: false, message: '请选择配送队' }

        const teamDoc = await db.collection('delivery_teams').doc(event.teamId).get()
        const team = teamDoc.data
        if (!team) return { success: false, message: '这支队伍暂时接不了' }

        // 同一家店对同一支队，一小时内只留一条待处理的，防止连点刷屏
        const since = new Date(Date.now() - 3600000)
        const dup = await db.collection('delivery_requests').where({
          shop_id: shop._id,
          team_id: event.teamId,
          status: 'open',
          created_at: db.command.gt(since)
        }).count()
        if (dup.total > 0) {
          return { success: false, message: '刚发过一条了，等队长回你' }
        }

        await db.collection('delivery_requests').add({
          data: {
            shop_id: shop._id,
            shop_name: shop.name,
            shop_owner: openid,
            // 队长要靠这个联系店长，所以必须存快照——
            // 店长事后改了微信号，已发出的请求还得能找到人
            shop_wechat: shop.contact_wechat || '',
            team_id: event.teamId,
            team_name: team.name,
            note: note,
            // open 发出待联系 / accepted 队长接下了 / delivered 送到并传了照片
            status: 'open',
            photos: [],
            created_at: new Date()
          }
        })

        // 提醒队长。用的是「新订单通知」模板，订单类型填「配送委托」——
        // 当初加那个字段就是为了一个模板兼两种场景。
        if (team.admin) {
          try {
            const pad = n => (n < 10 ? '0' + n : '' + n)
            const now = new Date()
            await cloud.callFunction({
              name: 'sendSubscribe',
              data: {
                tpl: 'newOrder',
                toUser: team.admin,
                page: 'pages/teamdashboard/teamdashboard',
                data: {
                  buyer: shop.name,
                  orderType: '配送委托',
                  content: note,
                  amount: 0,          // 报酬由双方私下谈，这里没有数
                  time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                        ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
                }
              }
            })
          } catch (e) {
            console.warn('配送请求通知发送失败（不影响请求）：', e)
          }
        }

        return { success: true }
      }

      // 队长/队员看收到的请求
      case 'listForTeam': {
        const team = await getMyTeam(openid)
        if (!team) return { success: true, requests: [] }

        const where = { team_id: team._id }
        // 未送达的都算「进行中」，送达的进历史
        where.status = event.done === true ? 'delivered' : db.command.neq('delivered')

        const res = await db.collection('delivery_requests')
          .where(where).orderBy('created_at', 'desc').limit(50).get()
        return { success: true, requests: res.data }
      }

      // 店长看自己发出去的请求，含送达照片
      case 'listForShop': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: true, requests: [] }

        const res = await db.collection('delivery_requests')
          .where({ shop_id: shop._id })
          .orderBy('created_at', 'desc')
          .limit(50)
          .get()
        return { success: true, requests: res.data }
      }

      // 队长接下这一单
      case 'accept': {
        const team = await getMyTeam(openid)
        if (!team) return { success: false, message: '你不在任何队伍里' }

        const doc = await db.collection('delivery_requests').doc(event.id).get()
        if (!doc.data || doc.data.team_id !== team._id) {
          return { success: false, message: '没有权限' }
        }

        await db.collection('delivery_requests').doc(event.id).update({
          data: { status: 'accepted', accepted_at: new Date(), accepted_by: openid }
        })
        return { success: true }
      }

      // 送到了：传照片 + 标记送达。
      // 照片是这套流程里唯一的「凭证」——平台不派单也不结账，
      // 出了「说送了其实没送」的争议，能拿出来的只有这个。
      case 'deliver': {
        const team = await getMyTeam(openid)
        if (!team) return { success: false, message: '你不在任何队伍里' }

        const doc = await db.collection('delivery_requests').doc(event.id).get()
        const req = doc.data
        if (!req || req.team_id !== team._id) {
          return { success: false, message: '没有权限' }
        }

        const photos = (Array.isArray(event.photos) ? event.photos : [])
          .filter(f => typeof f === 'string' && f)
          .slice(0, 6)
        if (!photos.length) return { success: false, message: '至少传一张送达照片' }

        await db.collection('delivery_requests').doc(event.id).update({
          data: {
            status: 'delivered',
            photos: photos,
            delivered_at: new Date(),
            delivered_by: openid
          }
        })

        // 告诉店长送到了。发不出去不影响状态本身。
        try {
          const pad = n => (n < 10 ? '0' + n : '' + n)
          const now = new Date()
          await cloud.callFunction({
            name: 'sendSubscribe',
            data: {
              tpl: 'orderProgress',
              toUser: req.shop_owner,
              page: 'pages/deliveryask/deliveryask',
              data: {
                status: '已送达',
                item: req.team_name || '配送队',
                time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':00',
                tip: '配送队传了送达照片，去「配送状态」看'
              }
            }
          })
        } catch (e) {
          console.warn('送达通知发送失败（不影响状态）：', e)
        }

        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + event.action }
    }
  } catch (err) {
    console.error('deliveryRequest 失败：', event.action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
