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
//
// 2026-10-10 加了群发：店长可以一次发给所有队，先接先得。群发的请求
// broadcast: true，发出时 team_id 为空、target_team_ids 记下当时所有队；
// 谁先接就把 team_id 写成谁，之后和点名发的一模一样。某支队点「不接」
// 只记进 declined_team_ids，所有队都不接才整条变成 declined。
//
// 防「接了不去」（同日加的），平台不派单也不扣钱，能做的是让爽约有代价、让退出有出口：
//   - 群发的请求接单前看不到店长微信。先接下来才能联系，别的队拿不到号去私下截胡
//   - 队伍接了发现去不了，可以「退单」：群发的回到池子里给别的队，点名的告诉店长换队。
//     诚实退单不记爽约——给了正当出口，才好意思罚不吭声的
//   - 店长可以把接了没来的单标成「没来送」(no_show)：队伍爽约 +1，
//     满 NO_SHOW_LIMIT 次自动下架，管理员核实后可恢复
//   - 送达 / 爽约次数摆在店长挑队的卡片上，靠谱的队自然被多选

// 和 deliveryManage 的说明里写的是同一个数，改要一起改
const NO_SHOW_LIMIT = 3

const MAX_COUNT = 200   // 一趟最多填几单，防手滑多打个 0

// 这一趟送哪、每单多少钱、几单。
//
// 价格不让店长另填：小店设置里的配送费就是付给配送队的价（2026-10-10 约定，
// 两个数等价，省得店长对买家一个价、对队伍一个价）。所以只收单数，单价
// 从店铺上现读，不信前端传来的钱数。
//   送上门   一行：{ name: '送上门', fee: flat_delivery_fee, count }
//   取货点   每个点一行：{ name: 点名, fee: 点的费用, count }，0 单的点不要
// 返回 { lines, total } 或 { error }。
function buildLines(shop, event) {
  const toCount = v => Math.max(0, Math.min(MAX_COUNT, Math.floor(Number(v) || 0)))
  let lines
  if (shop.exact_address) {
    lines = [{ name: '送上门', fee: Number(shop.flat_delivery_fee) || 0, count: toCount(event.count) }]
  } else {
    const counts = event.counts || {}
    lines = (shop.pickup_points || []).map(p => ({
      name: p.name,
      fee: Number(p.fee) || 0,
      count: toCount(counts[p.name])
    }))
  }
  lines = lines.filter(l => l.count > 0)
  if (!lines.length) return { error: '至少填一单' }

  // 配送费为 0 的话配送队白跑，让店长先去设置里填
  const free = lines.find(l => l.fee <= 0)
  if (free) {
    return { error: (shop.exact_address ? '配送费' : '「' + free.name + '」的配送费') + '是 $0，先去小店设置填上' }
  }

  const total = Math.round(lines.reduce((sum, l) => sum + l.fee * l.count, 0) * 100) / 100
  return { lines: lines, total: total }
}

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

function nowText(withSeconds) {
  const pad = n => (n < 10 ? '0' + n : '' + n)
  const now = new Date()
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + (withSeconds ? ':00' : '')
}

// 告诉店长请求有了结果。发不出去不影响状态本身。
async function notifyShop(req, status, tip) {
  try {
    await cloud.callFunction({
      name: 'sendSubscribe',
      data: {
        tpl: 'orderProgress',
        toUser: req.shop_owner,
        page: 'pages/deliveryask/deliveryask',
        data: {
          status: status,
          item: req.team_name || '配送队',
          time: nowText(true),
          tip: tip
        }
      }
    })
  } catch (e) {
    console.warn('通知店长失败（不影响状态）：', e)
  }
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请先登录' }

  try {
    switch (event.action) {

      // 店长发起。teamId 为 'all' 时群发给所有队，先接先得
      case 'create': {
        const shop = await getMyShop(openid)
        if (!shop) return { success: false, message: '你还没有小店' }

        if (shop.needs_delivery === false) return { success: false, message: '小店设置的是无需线下交付' }

        // 旧版小程序不传单数，照旧只存说明，等新版铺开后去掉这个分支
        const legacy = event.count === undefined && event.counts === undefined
        const priced = legacy ? { lines: [], total: 0 } : buildLines(shop, event)
        if (priced.error) return { success: false, message: priced.error }

        const note = String(event.note || '').trim().slice(0, 300)
        if (!note) return { success: false, message: legacy ? '说清楚几单、什么时候、送到哪' : '写一下几点取货、几点前送到' }
        if (!event.teamId) return { success: false, message: '请选择配送队' }

        const broadcast = event.teamId === 'all'
        let teams
        if (broadcast) {
          const res = await db.collection('delivery_teams')
            .where({ takedown: db.command.neq(true) }).limit(100).get()
          teams = res.data
          if (!teams.length) return { success: false, message: '目前还没有配送队' }
        } else {
          const teamDoc = await db.collection('delivery_teams').doc(event.teamId).get()
          if (!teamDoc.data || teamDoc.data.takedown) return { success: false, message: '这支队伍暂时接不了' }
          teams = [teamDoc.data]
        }

        // 同一家店对同一支队（或同一次群发），一小时内只留一条待处理的，防止连点刷屏
        const since = new Date(Date.now() - 3600000)
        const dupWhere = {
          shop_id: shop._id,
          status: 'open',
          created_at: db.command.gt(since)
        }
        if (broadcast) dupWhere.broadcast = true
        else dupWhere.team_id = event.teamId
        const dup = await db.collection('delivery_requests').where(dupWhere).count()
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
            // 群发的在有队接下之前没有归属
            team_id: broadcast ? '' : teams[0]._id,
            team_name: broadcast ? '' : teams[0].name,
            broadcast: broadcast,
            target_team_ids: teams.map(t => t._id),
            declined_team_ids: [],
            // 快照：店长事后改了配送费，已发出的请求还按发出时的价
            address_type: shop.exact_address ? 'exact' : 'points',
            lines: priced.lines,
            total: priced.total,
            note: note,
            // open 发出待联系 / accepted 队长接下了 / delivered 送到并传了照片 /
            // declined 没接或退单 / no_show 接了没来（店长标的）
            status: 'open',
            photos: [],
            created_at: new Date()
          }
        })

        // 提醒队长。用的是「新订单通知」模板，订单类型填「配送委托」——
        // 当初加那个字段就是为了一个模板兼两种场景。群发时每个队长各发一条。
        await Promise.all(teams.filter(t => t.admin).map(t => cloud.callFunction({
          name: 'sendSubscribe',
          data: {
            tpl: 'newOrder',
            toUser: t.admin,
            page: 'pages/teamdashboard/teamdashboard',
            data: {
              buyer: shop.name,
              orderType: broadcast ? '配送委托·先接先得' : '配送委托',
              content: note,
              amount: priced.total,   // 按小店设置的配送费算出的合计，钱不经过平台
              time: nowText(false)
            }
          }
        }).catch(e => console.warn('配送请求通知发送失败（不影响请求）：', t._id, e))))

        return { success: true, teamCount: teams.length }
      }

      // 队长/队员看收到的请求。待办和历史一次拿齐：
      // 以前分两个 tab 各拉一次，切 tab 时上一次的回包晚到，会把别的 tab 的单子盖上来。
      case 'listForTeam': {
        const team = await getMyTeam(openid)
        if (!team) return { success: true, active: [], history: [], requests: [] }

        const _ = db.command
        const coll = db.collection('delivery_requests')
        // 下架的队只剩手上已经接了的单要收尾，新的一概看不到
        const activeWhere = team.takedown
          ? { team_id: team._id, status: 'accepted' }
          : _.or([
            // 点名给我们的 + 群发里还没人接、我们也没拒的
            { team_id: team._id, status: _.in(['open', 'accepted']) },
            {
              broadcast: true,
              status: 'open',
              target_team_ids: team._id,
              declined_team_ids: _.nin([team._id])
            }
          ])
        const [activeRes, historyRes] = await Promise.all([
          coll.where(activeWhere).orderBy('created_at', 'desc').limit(50).get(),
          coll.where({ team_id: team._id, status: _.in(['delivered', 'declined', 'no_show']) })
            .orderBy('created_at', 'desc').limit(20).get()
        ])

        // 群发的接下来之前不给店长微信
        const active = activeRes.data.map(q => (
          (q.broadcast && q.status === 'open') ? Object.assign({}, q, { shop_wechat: '' }) : q
        ))
        return {
          success: true,
          takedown: team.takedown === true,
          active: active,
          history: historyRes.data,
          // 旧版工作台还按 done 分两个 tab 拉、读 requests 字段。新版铺开后删掉这一行
          requests: event.done === true ? historyRes.data.filter(q => q.status === 'delivered') : active
        }
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

      // 队长接下这一单。群发的先接先得：带着 status: 'open' 做条件更新，
      // 两支队同时点也只有一支改得动，另一支 updated 为 0。
      case 'accept': {
        const team = await getMyTeam(openid)
        if (!team) return { success: false, message: '你不在任何队伍里' }
        if (team.takedown) return { success: false, message: '队伍已被下架，接不了新单' }

        const doc = await db.collection('delivery_requests').doc(event.id).get()
        const req = doc.data
        const mine = req && (req.broadcast
          ? (req.target_team_ids || []).indexOf(team._id) >= 0
          : req.team_id === team._id)
        if (!mine) return { success: false, message: '没有权限' }
        if (req.status !== 'open') {
          return { success: false, message: req.broadcast ? '已经被别的队接走了' : '这一单已经处理过了' }
        }

        const res = await db.collection('delivery_requests')
          .where({ _id: event.id, status: 'open' })
          .update({
            data: {
              status: 'accepted',
              team_id: team._id,
              team_name: team.name,
              accepted_at: new Date(),
              accepted_by: openid
            }
          })
        if (!res.stats || res.stats.updated !== 1) {
          return { success: false, message: req.broadcast ? '晚了一步，已经被别的队接走了' : '这一单已经处理过了' }
        }
        return { success: true }
      }

      // 队长不接。不给这个出口的话，接不了的单只能一直挂在待办里，
      // 店长那边也一直显示「等队长联系」，不知道该换一支队。
      //
      // 群发的只是把自己摘出去，别的队照样能接；所有队都拒了才算没人接。
      case 'decline': {
        const team = await getMyTeam(openid)
        if (!team) return { success: false, message: '你不在任何队伍里' }

        const doc = await db.collection('delivery_requests').doc(event.id).get()
        const req = doc.data
        if (!req) return { success: false, message: '没有权限' }
        if (req.status !== 'open') return { success: false, message: '这一单已经处理过了' }

        if (req.broadcast) {
          if ((req.target_team_ids || []).indexOf(team._id) < 0) {
            return { success: false, message: '没有权限' }
          }
          await db.collection('delivery_requests').doc(event.id).update({
            data: { declined_team_ids: db.command.addToSet(team._id) }
          })

          const after = (await db.collection('delivery_requests').doc(event.id).get()).data
          const left = (after.target_team_ids || [])
            .filter(id => (after.declined_team_ids || []).indexOf(id) < 0)
          if (!left.length) {
            const res = await db.collection('delivery_requests')
              .where({ _id: event.id, status: 'open' })
              .update({ data: { status: 'declined', declined_at: new Date() } })
            if (res.stats && res.stats.updated === 1) {
              await notifyShop(Object.assign({}, req, { team_name: '所有配送队' }),
                '没人接单', '这次没有队能接，换个时间再发试试')
            }
          }
          return { success: true }
        }

        if (req.team_id !== team._id) return { success: false, message: '没有权限' }

        await db.collection('delivery_requests').doc(event.id).update({
          data: { status: 'declined', declined_at: new Date(), declined_by: openid }
        })
        await notifyShop(req, '没接单', '这支队这次接不了，换一支试试')
        return { success: true }
      }

      // 队伍接了发现去不了，退单。只有还没送达的、自己接的单能退。
      // 群发的回到池子里（自己记进 declined_team_ids，别的队还能接）；点名的就是没接。
      case 'release': {
        const team = await getMyTeam(openid)
        if (!team) return { success: false, message: '你不在任何队伍里' }

        const doc = await db.collection('delivery_requests').doc(event.id).get()
        const req = doc.data
        if (!req || req.team_id !== team._id) return { success: false, message: '没有权限' }
        if (req.status !== 'accepted') return { success: false, message: '这一单已经处理过了' }

        const _ = db.command
        if (req.broadcast) {
          const declined = (req.declined_team_ids || []).concat(team._id)
          const left = (req.target_team_ids || []).filter(id => declined.indexOf(id) < 0)
          await db.collection('delivery_requests').where({ _id: event.id, status: 'accepted' }).update({
            data: left.length
              ? { status: 'open', team_id: '', team_name: '', declined_team_ids: _.addToSet(team._id), released_at: new Date() }
              : { status: 'declined', declined_team_ids: _.addToSet(team._id), declined_at: new Date() }
          })
          await notifyShop(req, '队伍退单', left.length ? '已重新放回给其他队，等别的队接' : '这次没有队能接，换个时间再发试试')
          return { success: true }
        }

        await db.collection('delivery_requests').where({ _id: event.id, status: 'accepted' }).update({
          data: { status: 'declined', declined_at: new Date(), declined_by: openid, released: true }
        })
        await notifyShop(req, '队伍退单', '这支队去不了了，换一支试试')
        return { success: true }
      }

      // 店长：接了没来。记一次爽约，满 NO_SHOW_LIMIT 次自动下架这支队。
      case 'noShow': {
        const doc = await db.collection('delivery_requests').doc(event.id).get()
        const req = doc.data
        if (!req || req.shop_owner !== openid) return { success: false, message: '没有权限' }
        if (req.status !== 'accepted') return { success: false, message: '只有配送中的单能标记' }

        const res = await db.collection('delivery_requests').where({ _id: event.id, status: 'accepted' }).update({
          data: { status: 'no_show', no_show_at: new Date() }
        })
        if (!res.stats || res.stats.updated !== 1) return { success: false, message: '这一单已经处理过了' }

        await db.collection('delivery_teams').doc(req.team_id).update({
          data: { no_show_count: db.command.inc(1), updated_at: new Date() }
        })
        const teamDoc = await db.collection('delivery_teams').doc(req.team_id).get()
        const t = teamDoc.data || {}
        if (!t.takedown && (t.no_show_count || 0) >= NO_SHOW_LIMIT) {
          await db.collection('delivery_teams').doc(req.team_id).update({
            data: { takedown: true, takedown_reason: 'no_show', takedown_at: new Date() }
          })
        }
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
        if (req.status !== 'open' && req.status !== 'accepted') {
          return { success: false, message: '这一单已经处理过了' }
        }

        const photos = (Array.isArray(event.photos) ? event.photos : [])
          .filter(f => typeof f === 'string' && f)
          .slice(0, 6)
        if (!photos.length) return { success: false, message: '至少传一张送达照片' }

        // 条件更新：照片传到一半，店长那边可能已经标了「没来送」，别把它盖成送达
        const done = await db.collection('delivery_requests')
          .where({ _id: event.id, status: db.command.in(['open', 'accepted']) })
          .update({
            data: {
              status: 'delivered',
              photos: photos,
              delivered_at: new Date(),
              delivered_by: openid
            }
          })
        if (!done.stats || done.stats.updated !== 1) return { success: false, message: '这一单已经处理过了' }

        try {
          await db.collection('delivery_teams').doc(team._id).update({
            data: { delivered_count: db.command.inc(1) }
          })
        } catch (e) {
          console.warn('送达计数失败（不影响状态）：', e)
        }

        await notifyShop(req, '已送达', '配送队传了送达照片，去「找配送队」看')

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
