const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 配送域：配送队管理。
//
// 2026-09-20 拆了两样东西：
//   1. 队伍核对（listForAudit / audit + audit_status 字段，管理端页面
//      pages/shopaudit）。建队即可用，和店铺「提交即开店」一个口径。
//      当初留核对是因为队伍会碰到别人的订单和买家联系方式；现在平台既不
//      派单也不下发买家信息，配送请求里只有店长自己的微信，没有可核对的东西。
//   2. 队伍的「服务中 / 打烊中」开关（setOpen + open 字段）。老文档里的
//      open 字段没人读了，留着不管。
//
// 2026-10-10 加回一道门槛，并补上事后治理：
//   1. 建队要「开队码」：管理员在「我的 → 配送队管理」里生成，一码一队，7 天
//      过期（集合 team_create_codes）。原因是有了群发之后，任何人建一支队就能
//      收到所有店长的请求。之前建好的队不受影响。
//      注意和队伍自己的 join_code（拉队员用的邀请码）不是一回事。
//   2. 队伍能被举报（submitReport 的 team 类型），管理员可以下架 / 恢复。
//      下架 = takedown: true，不删记录：底下挂着历史请求和送达照片。
//      下架的队不出现在挑队列表里、收不到群发、接不了新单。
//   3. 爽约记录：店长可以把接了没来的单标成「没来送」，记在 no_show_count 上，
//      满 3 次自动下架（deliveryRequest 的 NO_SHOW_LIMIT）（takedown_reason: 'no_show'），管理员核实后可恢复。
//
// 2026-10-10 又撤掉了「可配送时段」（setAvailability + availability 字段）：
// 队长不会天天去填，时段一过期队伍在店长那边就全灰了。现在队伍一直可选，
// 哪一趟能不能送，店长发请求后两人在微信里定。老文档里的 availability 留着不管。
//
// 定价不归平台。配送方案（服务地点 + 服务时间）属于实际执行配送的那一方：
//   店长自送   → 存在 shops 上，店长在店铺设置里自己填
//   外包给队伍 → 存在 delivery_teams 上，队长自己填
//
// 服务地点和场次必须同属一方——一趟配送就是「这些点、这个时间」，
// 拆开会出现店长想 13:00 送但只有 12:00 场次可选的情况。
//
// 钱也不经过平台：买家一次性付给店长，店长事后按对账结果结给配送队。
//
// 注意这里没有 expandBatches：把场次展开成「买家能选的具体日期」是买家侧的事，
// 那份逻辑住在 shopBrowse 和 buyerOrders 里。这里曾经留过第三份拷贝，
// 早就没人调用，却在场次模型改掉之后变成了一份会误导人的旧规则，所以删了。

// 服务地点。不是送到公寓门口，而是买家到服务地点自取——所以点位是可增删的，
// 一个校区一个点，哪天在 Link 公寓门口加一个也只是多一条记录。
// name 会被订单引用，改名会让历史订单在汇总里单独归一组，尽量别改。
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
// 过去的日期照样存下来——场次一过期就拒绝保存的话，队长连改收款方式都改不了。
// 该不该给买家看，由 expandBatches 决定。
function cleanBatches(raw) {
  if (!Array.isArray(raw)) return []
  const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const b = raw[0]
  if (!b || !isDate(b.date) || !isTime(b.cutoff) || !isTime(b.deliver_time)) return []
  if (b.deliver_time <= b.cutoff) return []
  return [{ date: b.date, cutoff: b.cutoff, deliver_time: b.deliver_time }]
}

// 配送队管理（开队码、下架 / 恢复）归运营管理员和超管
async function isTeamAdmin(openid) {
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  const roles = (me.data[0] && me.data[0].roles) || []
  return roles.includes('super_admin') || roles.includes('ops_admin')
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // 去掉了 0/O/1/I/l

function makeJoinCode(len) {
  let s = ''
  for (let i = 0; i < (len || 6); i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length))
  return s
}

const CREATE_CODE_DAYS = 7

async function getMyTeam(openid) {
  const asAdmin = await db.collection('delivery_teams').where({ admin: openid }).limit(1).get()
  if (asAdmin.data.length) return { team: asAdmin.data[0], role: 'admin' }

  const asMember = await db.collection('team_members').where({ openid: openid }).limit(1).get()
  if (!asMember.data.length) return { team: null, role: null }

  const teamDoc = await db.collection('delivery_teams').doc(asMember.data[0].team_id).get()
  return { team: teamDoc.data || null, role: 'member' }
}

// 兜底文案。原来不管什么异常都返回一句「操作失败，请重试」，集合没建、
// 权限不对、网络超时长得一模一样，只能去云函数日志里翻 errCode 才知道是哪种。
//
// 2026-09-20 就踩了一次：delivery_teams 集合还没在云开发控制台建出来，
// 「建队」和「挑配送队」两个毫不相干的入口同时报同一句话，查了半天。
// 集合不存在是本项目最常踩的一种——代码没问题，是环境缺东西，值得单独说清楚。
//
// 同时认 errCode 和 errMsg：错误码在不同基础库版本上不完全一致，
// 文案匹配兜住了对不上号的情况。
function failMessage(err) {
  const code = String((err && (err.errCode || err.code)) || '')
  const text = String((err && (err.errMsg || err.message)) || '')

  if (code === '-502005' || /collection not exists|COLLECTION_NOT_EXIST/i.test(text)) {
    return '数据库未初始化，请联系管理员'
  }
  if (/permission denied|PERMISSION_DENIED/i.test(text)) {
    return '数据库权限不足，请联系管理员'
  }
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) {
    return '网络超时，请重试'
  }
  return '操作失败，请重试'
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

      // 店长在「找配送队」页挑队伍时看的列表。
      // 下架的队不给。送达 / 爽约次数一起带上，店长挑队时看得到这支队靠不靠谱。
      case 'listTeams': {
        const res = await db.collection('delivery_teams')
          .where({ takedown: db.command.neq(true) }).limit(50).get()

        const teams = res.data.map(t => ({
          _id: t._id,
          name: t.name,
          description: t.description,
          contact_wechat: t.contact_wechat,
          pickup_points: t.pickup_points || [],
          batches: t.batches || [],
          delivered_count: t.delivered_count || 0,
          no_show_count: t.no_show_count || 0
        }))
        return { success: true, teams: teams }
      }

      case 'create': {
        const mine = await getMyTeam(openid)
        if (mine.team) return { success: false, message: '你已经在一个配送队里了' }

        const name = (event.name || '').trim()
        const contactWechat = (event.contact_wechat || '').trim()
        const paymentNote = (event.payment_note || '').trim()
        if (!name) return { success: false, message: '请填写队伍名称' }
        if (!contactWechat) return { success: false, message: '请填写队长微信，店长结算时要联系你' }
        if (!paymentNote) return { success: false, message: '请填写收款方式，店长按这个结配送费' }

        // 开队码：先占住（带 used: false 的条件更新，两个人拿同一个码同时提交
        // 只有一个改得动），建队失败再还回去
        const code = String(event.create_code || '').trim().toUpperCase()
        if (!code) return { success: false, message: '请填写开队码' }
        const found = await db.collection('team_create_codes').where({ code: code }).limit(1).get()
        const ticket = found.data[0]
        if (!ticket || ticket.used) return { success: false, message: '开队码不对或已经用过了' }
        if (new Date(ticket.expires_at) < new Date()) return { success: false, message: '开队码过期了，找管理员要个新的' }
        const claim = await db.collection('team_create_codes')
          .where({ _id: ticket._id, used: false })
          .update({ data: { used: true, used_by: openid, used_at: new Date() } })
        if (!claim.stats || claim.stats.updated !== 1) {
          return { success: false, message: '开队码不对或已经用过了' }
        }

        let nickname = ''
        try {
          const me = await db.collection('users').where({ openid: openid }).limit(1).get()
          nickname = (me.data[0] && me.data[0].nickname) || ''
        } catch (e) {
          console.warn('读取队长昵称失败：', e)
        }

        let res
        try {
          res = await db.collection('delivery_teams').add({
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
              create_code: code,
              approved_by: ticket.created_by,
              delivered_count: 0,
              no_show_count: 0,
              created_at: new Date(),
              updated_at: new Date()
            }
          })
        } catch (e) {
          await db.collection('team_create_codes').doc(ticket._id).update({
            data: { used: false, used_by: '', used_at: null }
          })
          throw e
        }

        await db.collection('team_create_codes').doc(ticket._id).update({
          data: { team_id: res._id, team_name: name }
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
        if (team.takedown) return { success: false, message: '这支队已被下架' }

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

      // ---- 管理员：配送队管理 ----

      // 生成一个开队码。note 记给谁的，方便日后对得上是谁建的队
      case 'makeCreateCode': {
        if (!(await isTeamAdmin(openid))) return { success: false, message: '没有权限' }
        const code = makeJoinCode(8)
        const expires = new Date(Date.now() + CREATE_CODE_DAYS * 24 * 3600 * 1000)
        await db.collection('team_create_codes').add({
          data: {
            code: code,
            note: String(event.note || '').trim().slice(0, 30),
            created_by: openid,
            created_at: new Date(),
            expires_at: expires,
            used: false
          }
        })
        return { success: true, code: code, expires_at: expires }
      }

      // 管理页一次拿齐：最近的开队码 + 所有队伍（含已下架的）
      case 'adminOverview': {
        if (!(await isTeamAdmin(openid))) return { success: false, message: '没有权限' }
        const [codes, teams] = await Promise.all([
          db.collection('team_create_codes').orderBy('created_at', 'desc').limit(30).get(),
          db.collection('delivery_teams').orderBy('created_at', 'desc').limit(100).get()
        ])
        return {
          success: true,
          codes: codes.data,
          teams: teams.data.map(t => ({
            _id: t._id,
            name: t.name,
            admin_nickname: t.admin_nickname || '',
            contact_wechat: t.contact_wechat || '',
            delivered_count: t.delivered_count || 0,
            no_show_count: t.no_show_count || 0,
            takedown: t.takedown === true,
            takedown_reason: t.takedown_reason || '',
            created_at: t.created_at
          }))
        }
      }

      // 下架 / 恢复。恢复时把爽约次数清零，否则下一次爽约又立刻自动下架
      case 'setTakedown': {
        if (!(await isTeamAdmin(openid))) return { success: false, message: '没有权限' }
        if (!event.teamId) return { success: false, message: '参数不完整' }
        const down = event.takedown === true
        await db.collection('delivery_teams').doc(event.teamId).update({
          data: down
            ? { takedown: true, takedown_reason: 'admin', takedown_at: new Date(), updated_at: new Date() }
            : { takedown: false, takedown_reason: '', no_show_count: 0, updated_at: new Date() }
        })
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    // errCode 单独打一次：日志里一眼能看到是哪类错，不用展开整个 err 对象
    console.error('deliveryManage 失败：', action, (err && err.errCode) || '', err)
    // errCode 回给前端只为了开发时在调试器里看，页面不展示它
    return { success: false, message: failMessage(err), errCode: (err && err.errCode) || null }
  }
}
