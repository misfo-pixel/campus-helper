// 开店向导（pages/shopcreate）和小店设置（pages/shopedit）共用的那部分。
//
// 两个页面现在是分开的：向导是一步步问，设置是一张长表单随便改。
// 但图片上传、方案校验这些必须一致，所以抽到这里，
// 免得改了一边忘了另一边。

const { dateText, slotText } = require('./date.js')

// 选图时只拿到本地临时路径，提交时才真的传。
// 没换图（temp 为空）就把原来的云文件 ID 原样返回，别重复上传。
function uploadShopImage(tempPath, saved, dir) {
  if (!tempPath) return Promise.resolve(saved || '')

  const match = tempPath.match(/\.(\w+)$/)
  const ext = match ? match[1] : 'jpg'
  const cloudPath = dir + '/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath }).then(r => r.fileID)
}

// 配送这块是【两个正交的问题】，分两层问，别压成一个三选一：
//
//   第一层 exact_address：送到买家地址，还是买家过来取？
//   第二层 delivery_mode：只有送上门才有这一问——自己送，还是找配送队？
//
// 客户自取的时候不存在「谁来送」，所以第二层整个不出现。
// 反过来把自取塞进三选一里，就是把两个维度压扁——用户得同时想两件事。
//
// 'outsourced'（把店绑死在一支队上）和 'task'（撤掉的委托送）都是历史值。
const DELIVERY_MODES = ['self', 'team']

function normalizeMode(value) {
  return (value === 'outsourced' || value === 'team') ? 'team' : 'self'
}

// 提交前的方案校验，两个页面共用。返回第一条错，null = 通过。
//
// exactAddress 为 true 时送到买家自己填的地址，没有固定点位可校验，
// 只需要一个有效的服务时间。
function validatePlan(points, batches, exactAddress) {
  if (!exactAddress) {
    const kept = (points || []).filter(p => String(p.name || '').trim())
    if (!kept.length) return '至少要设一个服务地点'

    const names = kept.map(p => p.name.trim())
    if (new Set(names).size !== names.length) return '服务地点名字不能重复'
  }

  // 日期只校验填没填，不校验是不是过去的日子——否则场次一过期，
  // 店长连改商品、改联系方式都保存不了。
  const batch = (batches || [])[0]
  if (!batch || !batch.date) return '请选择服务时间的日期'
  if (batch.deliver_time <= batch.cutoff) return '送达时间要晚于截单时间'
  return null
}

// ---- 配送队按时间可选 ----
//
// 队伍没有「打烊」开关了：队长在工作台填几条可配送时段
//（delivery_teams.availability），填了哪几段就是那几段接活，一段不填
// 等于以前的打烊。少一个要人记得去关的状态。
//
// 店铺这边给出的是服务时间里的送达时刻（batches[0].date + deliver_time），
// 但要的不是「那一秒有没有人」：车不会在送达那一刻凭空出现，得先取到货、
// 过去、交接。所以按送达时刻前后各留 30 分钟算一个窗口，要求队伍在这
// 一整段里都有空——只比一个点的话，填了 19:00-20:00 的队会被算成能送 19:00，
// 而那一趟从 18:30 就得出发。
//
// 截单时间不参与判断：那是买家那边的事，和队伍几点出车无关。
const BUFFER_MIN = 30

function toMinutes(hhmm) {
  const bits = String(hhmm || '').split(':')
  return Number(bits[0]) * 60 + Number(bits[1])
}

function toHHMM(min) {
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(Math.floor(min / 60)) + ':' + pad(min % 60)
}

// 窗口夹在当天之内。时段本身跨不了夜（end > start，且挂在某一天上），
// 所以 23:45 送达要是老老实实算成 [23:15, 00:15]，那天就永远没人能接了。
// 夹到 23:59 至少还判得出来，跨夜那半小时留给他们自己在微信里说。
function batchWindow(batches) {
  const b = (batches || [])[0]
  if (!b || !b.date || !b.deliver_time) return null
  const t = toMinutes(b.deliver_time)
  return {
    date: b.date,
    at: b.deliver_time,
    from: Math.max(0, t - BUFFER_MIN),
    to: Math.min(24 * 60 - 1, t + BUFFER_MIN)
  }
}

// 同一天里相邻或重叠的时段先并起来再比。队长完全可能把连着的四小时填成
// 18:00-20:00 和 20:00-22:00 两行，不并的话 20:00 送达两头都盖不住，
// 灰得毫无道理——而他明明整晚都在。
function mergedSlots(availability, date) {
  const sorted = (availability || [])
    .filter(s => s && s.date === date)
    .map(s => ({ from: toMinutes(s.start), to: toMinutes(s.end) }))
    .sort((a, b) => a.from - b.from)

  const out = []
  sorted.forEach(s => {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ from: s.from, to: s.to })
  })
  return out
}

// 两端都算覆盖：窗口正好卡在时段边上（18:30-19:30 对 18:30-20:00）是能送的。
function teamCovers(team, win) {
  return mergedSlots((team && team.availability) || [], win.date)
    .some(s => s.from <= win.from && win.to <= s.to)
}

// 队伍卡片上最多摆几条时段：这是用来挑队伍的，不是排班表。
const SHOWN_SLOTS = 3

// 店铺表单（开店向导 / 小店设置）里那份队伍列表的显示规则，两边共用一份。
//
//   - 送达时间还没填 → 无从判断，一律可选。这时候置灰，等于让店长在还没
//     给出判断依据的时候对着一个灰按钮猜自己该改什么。
//   - 已经选中的那支永远可选，哪怕改完时间对不上了——否则店长打开设置页
//     会发现自己绑的队凭空消失，以为绑定丢了，重新挑一支把好配置改坏。
//     这种情况改用一句警告说清楚（下面的 warn），选择权留给他。
//   - 其余按「有没有一整段可配送时段盖住送达前后各 30 分钟」。
//
// 返回 { teams, disabled, reason, warn }。文案里把窗口摊开写（不只写送达
// 时刻），否则店长看着一支「19:00-20:00」的队被 19:00 送达灰掉，只会当成 bug。
// reason 分两种也是有意的：「一支队都没有」店长改送达时间也没用，
// 「有队但这一段都没空」改了就有。
function markTeams(teams, batches, selectedId) {
  const win = batchWindow(batches)
  const winText = win
    ? (dateText(win.date) + ' ' + toHHMM(win.from) + '-' + toHHMM(win.to))
    : ''

  const list = (teams || []).map(t => {
    const covers = !win || teamCovers(t, win)
    const slots = (t.availability || []).map(slotText)
    return Object.assign({}, t, {
      selectable: covers || t._id === selectedId,
      // 时间对不上的队也要把时段摆出来：店长照着改自己的送达时间就能用上，
      // 比只看到一张灰卡片有用
      offTime: !covers,
      slotTexts: slots.slice(0, SHOWN_SLOTS),
      slotMore: Math.max(0, slots.length - SHOWN_SLOTS)
    })
  })

  const selected = list.find(t => t._id === selectedId)
  return {
    teams: list,
    disabled: !list.some(t => t.selectable),
    reason: list.length === 0
      ? '目前还没有配送队，可以先自己送'
      : '送一趟要占 ' + winText + '（送达前后各半小时），这段时间没有队有空。换个送达时间或者自己送',
    warn: (selected && selected.offTime)
      ? '「' + selected.name + '」在 ' + winText + ' 没空——送 ' + (win ? win.at : '') + ' 这一趟，前后各要留半小时。可以换一支，或者把送达时间挪到他们能出车的时段里。'
      : ''
  }
}

module.exports = {
  DELIVERY_MODES: DELIVERY_MODES,
  normalizeMode: normalizeMode,
  uploadShopImage: uploadShopImage,
  validatePlan: validatePlan,
  markTeams: markTeams
}
