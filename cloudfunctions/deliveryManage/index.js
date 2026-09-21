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
//   2. 队伍的「服务中 / 打烊中」开关（setOpen + open 字段）。能不能接活
//      现在完全由 availability（可配送时段）表达：填了哪几段就是那几段接，
//      一段不填等于打烊。老文档里的 open 字段没人读了，留着不管。
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

// 可配送时段。队长在工作台填「哪天几点能出车」。
//
// 这是队伍唯一的「接不接活」信号：店铺那一趟的送达时刻前后各半小时，
// 整段落在某条时段里，这支队才选得中，盖不住的置灰（判断在小程序端
// utils/shopForm.js 的 markTeams 里——服务端不拦，理由见 shopManage 的
// checkTeamBindable）。留半小时是因为车得先取到货再过去，不是送达那一秒
// 凭空出现。
//
// 和上面的 batches 不是一回事，别合并：batches 是店铺那一趟的截单时刻 +
// 送达时刻，一家店一条；这里是队伍自己哪几段能出车，一支队好几条。
//
// 上限 8 条：再多就不是「最近能送」而是一张排班表了，店长也看不过来。
const MAX_SLOTS = 8

function cleanAvailability(raw) {
  if (!Array.isArray(raw)) return []
  const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s)

  return raw
    .filter(s => s && isDate(s.date) && isTime(s.start) && isTime(s.end) && s.end > s.start)
    .map(s => ({ date: s.date, start: s.start, end: s.end }))
    // 按时间先后排好再存：店长看到的顺序就是时间顺序，不是队长录入的顺序。
    // 队长那边不跟着排，免得他正改日期时整行跳走，下次进页面自然就是排好的。
    .sort((a, b) => (a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1)))
    .slice(0, MAX_SLOTS)
}

// 过去的时段照样存下来（和 cleanBatches 一个道理：一过期就拒绝保存，队长
// 想加下周的都加不了），该不该露出由这里决定。
//
// 要按明尼苏达当地时间判断，不能用服务器时间——云函数跑在 UTC，
// 晚上 7 点之后当天的时段会被算成「昨天的」全部消失。
// 这段和 shopBrowse / buyerOrders 里的 nowInTZ 是同一份，云函数之间没法共享代码。
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

// 已经过完的时段不再下发。队长忘了删的上周时段，店长照着约就白约一场。
// 队长那边也走这个过滤：他下次保存时提交的就是过滤后的列表，旧时段顺带清掉了。
function upcomingSlots(list) {
  const now = nowInTZ()
  const toMinutes = hhmm => {
    const bits = String(hhmm).split(':')
    return Number(bits[0]) * 60 + Number(bits[1])
  }
  return (list || []).filter(s => {
    if (!s || !s.date) return false
    if (s.date < now.date) return false
    if (s.date === now.date && toMinutes(s.end) <= now.minutes) return false
    return true
  })
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
        // 过期的时段不回给队长：他看到的这份列表，就是店长那边看到的那份
        team.availability = upcomingSlots(team.availability)

        return { success: true, team: team, role: mine.role, members: members.data }
      }

      // 店长在店铺设置 / 配送状态页里挑队伍时看的列表。
      //
      // 时段和店长那一趟对不上的队也照样返回，不在这里过滤：一来店长可能
      // 已经绑了其中一支，服务端滤掉的话那支队会凭空消失，他会以为绑定丢了；
      // 二来「什么时候的单」只有店长那边知道，服务端没有那个上下文。
      // 该置灰还是该显示，由看得见上下文的那一层决定。
      case 'listTeams': {
        const res = await db.collection('delivery_teams').limit(50).get()

        const teams = res.data.map(t => ({
          _id: t._id,
          name: t.name,
          description: t.description,
          contact_wechat: t.contact_wechat,
          pickup_points: t.pickup_points || [],
          batches: t.batches || [],
          // 队长填的可配送时段，店长拿自己的送达时间去比
          availability: upcomingSlots(t.availability)
        }))

        // 还有时段可用的排前面，店长一眼看到能约的
        teams.sort((a, b) => {
          const an = a.availability.length ? 0 : 1
          const bn = b.availability.length ? 0 : 1
          return an - bn
        })
        return { success: true, teams: teams }
      }

      // 队长改可配送时段。队员只能看——时间是队长和店长约的，队员改了会把
      // 已经约好的一趟改没。
      //
      // 整份列表覆盖写，不做增删单条的接口：前端本来就拿着全量，
      // 一次改一条还要处理「服务端这条已经不在了」的情况，不划算。
      case 'setAvailability': {
        const mine = await getMyTeam(openid)
        if (!mine.team || mine.role !== 'admin') {
          return { success: false, message: '只有队长能改可配送时段' }
        }

        const slots = cleanAvailability(event.availability)
        await db.collection('delivery_teams').doc(mine.team._id).update({
          data: { availability: slots, updated_at: new Date() }
        })
        return { success: true, availability: upcomingSlots(slots) }
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
            // 可配送时段在工作台填，不在建队表单里——建队时队长还不知道
            // 自己哪天能出车。这里只占个位，免得读的地方要判 undefined。
            // 空着就是谁也选不到这支队，队长填了第一条才开始接活。
            availability: [],
            join_code: makeJoinCode(),
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

        // 这里故意不碰 availability：队伍设置表单里没有这一项，跟着写一遍
        // 就会把队长在工作台填的可配送时段清空（pickup_points / batches 现在
        // 就是这么被清掉的——那两个已经没人填了，availability 有人填），
        // 而清空 = 这支队从所有店长的可选列表里消失。
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
