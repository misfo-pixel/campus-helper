const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 配送域：配送队管理 + 平台侧的单量统计。
//
// 定价不归平台。配送方案（取餐点 + 批次时间）属于实际执行配送的那一方：
//   商家自送   → 存在 shops 上，商家在店铺设置里自己填
//   外包给队伍 → 存在 delivery_teams 上，队长自己填
//
// 取餐点和批次必须同属一方——一趟配送就是「这些点、这个时间」，
// 拆开会出现商家想 13:00 送但只有 12:00 班次可选的情况。
//
// 钱也不经过平台：买家一次性付给商家，商家事后按对账结果结给配送队。

// 用户都在明尼苏达，批次的「今天还赶不赶得上」必须按当地时间算，
// 不能用服务器时间（云函数跑在 UTC / 上海）。Intl 会自己处理夏令时。
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
  if (hour === 24) hour = 0     // 某些 locale 的 hourCycle 会把午夜给成 24
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    minutes: hour * 60 + Number(parts.minute)
  }
}

function toMinutes(hhmm) {
  const bits = String(hhmm).split(':')
  return Number(bits[0]) * 60 + Number(bits[1])
}

function addDays(dateStr, n) {
  // 取当天正午再加减，避免时区把日期推过头
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// 把批次模板展开成「买家现在能选的具体场次」。
// 今天这班还没截单就是今天的，截了就顺延到明天。
function expandBatches(batches) {
  const now = nowInTZ()
  return (batches || []).map(b => {
    const cutoffMin = toMinutes(b.cutoff)
    const isToday = now.minutes < cutoffMin
    const date = isToday ? now.date : addDays(now.date, 1)
    return {
      key: date + '#' + b.label,
      label: b.label,
      date: date,
      cutoff: b.cutoff,
      deliver_time: b.deliver_time,
      isToday: isToday,
      minutesLeft: isToday ? cutoffMin - now.minutes : null
    }
  })
}

// 取餐点。不是送到公寓门口，而是买家到点自取——所以点位是可增删的，
// 一个校区一个点，哪天在 Link 公寓门口加一个也只是多一条记录。
// name 会被订单引用，改名会让历史订单在汇总里单独归一组，尽量别改。
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
  const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
  return raw
    .filter(b => b && b.label && isTime(b.cutoff) && isTime(b.deliver_time))
    .map(b => ({
      label: String(b.label).trim(),
      cutoff: b.cutoff,
      deliver_time: b.deliver_time
    }))
    .sort((a, b) => toMinutes(a.cutoff) - toMinutes(b.cutoff))
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // 去掉了 0/O/1/I/l

function makeJoinCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length))
  return s
}

async function getMyTeam(openid) {
  const asAdmin = await db.collection('delivery_teams').where({ admin: openid }).limit(1).get()
  if (asAdmin.data.length) return { team: asAdmin.data[0], role: 'admin' }

  const asMember = await db.collection('team_members').where({ openid: openid }).limit(1).get()
  if (!asMember.data.length) return { team: null, role: null }

  const teamDoc = await db.collection('delivery_teams').doc(asMember.data[0].team_id).get()
  return { team: teamDoc.data || null, role: 'member' }
}

async function getRoles(openid) {
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  return (me.data[0] && me.data[0].roles) || []
}

// 配送域的管理动作（改配置、审队伍）超管和饭搭子管理员都能做。
// 饭搭子管理员是日常运营的人，定价要跟着单量走，卡在超管那儿反而不合理。
async function canAudit(openid) {
  const roles = await getRoles(openid)
  return roles.includes('super_admin') || roles.includes('food_admin')
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    switch (action) {

      // ---- 配送队 ----

      case 'getMine': {
        const mine = await getMyTeam(openid)
        if (!mine.team) return { success: true, team: null, role: null }

        const members = await db.collection('team_members')
          .where({ team_id: mine.team._id }).limit(100).get()

        // 邀请码只给队长看，免得队员随手转发出去
        const team = Object.assign({}, mine.team)
        if (mine.role !== 'admin') delete team.join_code

        return { success: true, team: team, role: mine.role, members: members.data }
      }

      // 商家在店铺设置里挑队伍时看的列表
      case 'listApproved': {
        const res = await db.collection('delivery_teams')
          .where({ audit_status: 'approved' }).limit(50).get()
        return {
          success: true,
          teams: res.data.map(t => ({
            _id: t._id,
            name: t.name,
            description: t.description,
            contact_wechat: t.contact_wechat,
            pickup_points: t.pickup_points || [],
            batches: t.batches || []
          }))
        }
      }

      case 'create': {
        const mine = await getMyTeam(openid)
        if (mine.team) return { success: false, message: '你已经在一个配送队里了' }

        const name = (event.name || '').trim()
        const contactWechat = (event.contact_wechat || '').trim()
        const paymentNote = (event.payment_note || '').trim()
        if (!name) return { success: false, message: '请填写队伍名称' }
        if (!contactWechat) return { success: false, message: '请填写队长微信，商家结算时要联系你' }
        if (!paymentNote) return { success: false, message: '请填写收款方式，商家按这个结配送费' }

        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取队长昵称失败：', e)
        }

        const res = await db.collection('delivery_teams').add({
          data: {
            name: name,
            description: (event.description || '').trim(),
            admin: openid,
            admin_nickname: nickname,
            contact_wechat: contactWechat,
            payment_note: paymentNote,
            pickup_points: cleanPickupPoints(event.pickup_points),
            batches: cleanBatches(event.batches),
            join_code: makeJoinCode(),
            audit_status: 'pending',
            audit_reason: '',
            created_at: new Date(),
            updated_at: new Date()
          }
        })

        // 队长本人也是成员，配送单要能派给他
        await db.collection('team_members').add({
          data: {
            team_id: res._id,
            openid: openid,
            nickname: nickname,
            role: 'admin',
            joined_at: new Date()
          }
        })

        return { success: true, teamId: res._id }
      }

      case 'update': {
        const mine = await getMyTeam(openid)
        if (!mine.team || mine.role !== 'admin') {
          return { success: false, message: '只有队长能改队伍设置' }
        }
        const name = (event.name || '').trim()
        if (!name) return { success: false, message: '请填写队伍名称' }

        await db.collection('delivery_teams').doc(mine.team._id).update({
          data: {
            name: name,
            description: (event.description || '').trim(),
            contact_wechat: (event.contact_wechat || '').trim(),
            payment_note: (event.payment_note || '').trim(),
            pickup_points: cleanPickupPoints(event.pickup_points),
            batches: cleanBatches(event.batches),
            updated_at: new Date()
          }
        })
        return { success: true }
      }

      case 'join': {
        const mine = await getMyTeam(openid)
        if (mine.team) return { success: false, message: '你已经在一个配送队里了' }

        const code = (event.code || '').trim().toUpperCase()
        if (!code) return { success: false, message: '请输入邀请码' }

        const res = await db.collection('delivery_teams').where({ join_code: code }).limit(1).get()
        if (!res.data.length) return { success: false, message: '邀请码不对' }

        const team = res.data[0]
        if (team.audit_status !== 'approved') {
          return { success: false, message: '这个队伍还没通过审核' }
        }

        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取昵称失败：', e)
        }

        await db.collection('team_members').add({
          data: {
            team_id: team._id,
            openid: openid,
            nickname: nickname,
            role: 'member',
            joined_at: new Date()
          }
        })
        return { success: true, teamName: team.name }
      }

      // 队长踢人，或者队员自己退出
      case 'removeMember': {
        const mine = await getMyTeam(openid)
        if (!mine.team) return { success: false, message: '你不在任何配送队里' }

        const target = event.openid || openid
        if (target !== openid && mine.role !== 'admin') {
          return { success: false, message: '只有队长能移除其他成员' }
        }
        if (target === mine.team.admin) {
          return { success: false, message: '队长不能退出，请先解散或转让队伍' }
        }

        const res = await db.collection('team_members')
          .where({ team_id: mine.team._id, openid: target }).limit(1).get()
        if (!res.data.length) return { success: false, message: '此人不在队伍里' }

        await db.collection('team_members').doc(res.data[0]._id).remove()
        return { success: true }
      }

      case 'resetCode': {
        const mine = await getMyTeam(openid)
        if (!mine.team || mine.role !== 'admin') {
          return { success: false, message: '只有队长能重置邀请码' }
        }
        const code = makeJoinCode()
        await db.collection('delivery_teams').doc(mine.team._id).update({
          data: { join_code: code, updated_at: new Date() }
        })
        return { success: true, join_code: code }
      }

      // 队长代加队员。
      // 队员靠邀请码自助加入的入口藏在配送工作台里，而普通用户看不到那个入口，
      // 所以得让队长能直接把人拉进来。按微信号找人——用户在「编辑资料」里填过。
      case 'addMemberByWechat': {
        const mine = await getMyTeam(openid)
        if (!mine.team || mine.role !== 'admin') {
          return { success: false, message: '只有队长能添加成员' }
        }

        const wechat = (event.wechat || '').trim()
        if (!wechat) return { success: false, message: '请输入对方的微信号' }

        const found = await db.collection('users').where({ wechat: wechat }).limit(5).get()
        if (!found.data.length) {
          return { success: false, message: '没找到这个微信号。让对方先进小程序，在「我的 → 编辑资料」里填上微信号' }
        }
        if (found.data.length > 1) {
          return { success: false, message: '有多个用户填了同一个微信号，没法确定是谁' }
        }

        const target = found.data[0]
        const already = await db.collection('team_members')
          .where({ openid: target.openid }).limit(1).get()
        if (already.data.length) {
          return {
            success: false,
            message: already.data[0].team_id === mine.team._id ? '这个人已经在你的队里了' : '这个人已经在别的配送队里了'
          }
        }

        await db.collection('team_members').add({
          data: {
            team_id: mine.team._id,
            openid: target.openid,
            nickname: target.nickname || '',
            role: 'member',
            joined_at: new Date()
          }
        })
        return { success: true, nickname: target.nickname || '未设昵称' }
      }

      // 调价要有依据。这里把最近 N 天的单量按批次和取餐点摊开，
      // 让管理员看着真实数据改费率，而不是拍脑袋。
      case 'stats': {
        if (!(await canAudit(openid))) return { success: false, message: '没有权限' }

        const days = Math.min(Math.max(Number(event.days) || 30, 7), 90)
        const since = new Date(Date.now() - days * 24 * 3600 * 1000)

        const res = await db.collection('food_orders')
          .where({ created_at: db.command.gte(since) })
          .limit(1000)
          .get()

        // 取消的单不算进量，否则会高估需求
        const orders = res.data.filter(o => o.status !== 'cancelled')

        const byBatch = {}
        const byPoint = {}
        const activeDates = {}

        orders.forEach(o => {
          const b = o.batch_label || '未知批次'
          if (!byBatch[b]) byBatch[b] = { label: b, count: 0, dates: {} }
          byBatch[b].count++
          if (o.batch_date) byBatch[b].dates[o.batch_date] = true

          const p = o.pickup_point || o.building || '未知取餐点'
          if (!byPoint[p]) byPoint[p] = { name: p, count: 0, fee_sum: 0 }
          byPoint[p].count++
          byPoint[p].fee_sum += Number(o.delivery_fee_owed) || 0

          if (o.batch_date) activeDates[o.batch_date] = true
        })

        const total = orders.length
        const batches = Object.keys(byBatch).map(k => {
          const b = byBatch[k]
          const dayCount = Object.keys(b.dates).length || 1
          return {
            label: b.label,
            count: b.count,
            // 平均单量按「这个批次实际开过的天数」算，没开的天不该拉低平均
            avg: Math.round(b.count / dayCount * 10) / 10,
            days: dayCount
          }
        }).sort((a, b) => b.count - a.count)

        const points = Object.keys(byPoint).map(k => {
          const p = byPoint[k]
          return {
            name: p.name,
            count: p.count,
            share: total ? Math.round(p.count / total * 100) : 0,
            fee_total: Math.round(p.fee_sum * 100) / 100
          }
        }).sort((a, b) => b.count - a.count)

        return {
          success: true,
          days: days,
          total: total,
          activeDays: Object.keys(activeDates).length,
          batches: batches,
          points: points
        }
      }

      // ---- 审核队伍 ----

      case 'listForAudit': {
        if (!(await canAudit(openid))) return { success: false, message: '没有权限' }
        const res = await db.collection('delivery_teams')
          .where({ audit_status: event.status || 'pending' })
          .orderBy('created_at', 'desc').limit(100).get()
        return { success: true, teams: res.data }
      }

      case 'audit': {
        if (!(await canAudit(openid))) return { success: false, message: '没有权限' }

        const approved = event.approve === true
        await db.collection('delivery_teams').doc(event.teamId).update({
          data: {
            audit_status: approved ? 'approved' : 'rejected',
            audit_reason: approved ? '' : (event.reason || ''),
            audited_by: openid,
            audited_at: new Date()
          }
        })

        // 队伍被驳回，把绑了它的商家退回自送，免得订单派不出去
        if (!approved) {
          await db.collection('shops')
            .where({ delivery_team_id: event.teamId })
            .update({ data: { delivery_mode: 'self', delivery_team_id: '' } })
        }
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('deliveryManage 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
