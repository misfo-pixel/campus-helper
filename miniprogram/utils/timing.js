// 延迟测量。目标是分清三件事：
//   A. 纯链路开销  —— ping 空云函数，什么都不干，耗时 = 微信通道 + 跨太平洋 + 调度
//   B. 云函数路径  —— 业务云函数，比 A 多出来的部分是你的代码和数据库
//   C. 直连数据库  —— wx.cloud.database() 走的是另一条通道，特征跟云函数不一样
//
// 第三条是很多教程会漏掉的：这个项目里市场页、我的闲置都是直连数据库，
// 而市场页恰恰是用户进来第一眼看到的，只测云函数会漏掉最该测的那条路径。
const { DEBUG_TIMING } = require('../config.js')

const records = []

function push(name, totalMs, dbg) {
  const row = {
    time: new Date().toLocaleTimeString(),
    name: name,
    total: totalMs,
    exec: dbg ? dbg.execMs : null,       // 云函数内部执行耗时
    n: dbg ? dbg.n : null,               // 该实例第几次被调用，1 = 冷启动
    inst: dbg ? dbg.instance : null
  }
  records.push(row)
  // 每攒够 6 条（3 对）自动打一次汇总，不用手动触发任何东西
  if (records.length % 6 === 0) setTimeout(report, 0)
  console.log(
    '[timing] ' + row.time + ' ' + name +
    ' total=' + row.total + 'ms' +
    ' exec=' + (row.exec === null ? '-' : row.exec + 'ms') +
    ' n=' + (row.n === null ? '-' : row.n) +
    (row.n === 1 ? ' ❄️冷启动' : '')
  )
  return row
}

// 云函数：用法和 wx.cloud.callFunction 一样
function timedCall(name, data) {
  if (!DEBUG_TIMING) return wx.cloud.callFunction({ name: name, data: data })
  const start = Date.now()
  return wx.cloud.callFunction({ name: name, data: data }).then(res => {
    const dbg = res && res.result && res.result._debug
    push(name, Date.now() - start, dbg)
    return res
  }, err => {
    push(name + ' ❌', Date.now() - start, null)
    throw err
  })
}

// 直连数据库：传一个「返回 Promise 的函数」进来，不是 Promise 本身——
// 否则计时起点会落在请求已经发出之后。
//   timedDb('market.list', () => db.collection('x').get())
function timedDb(label, fn) {
  if (!DEBUG_TIMING) return fn()
  const start = Date.now()
  return fn().then(res => {
    push('db:' + label, Date.now() - start, null)
    return res
  }, err => {
    push('db:' + label + ' ❌', Date.now() - start, null)
    throw err
  })
}

// 取中位数，不用平均值——平均值会被个别抖动带偏
function median(arr) {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function report() {
  if (!records.length) {
    console.log('[timing] 还没有数据')
    return
  }
  console.log('=== timing report ===')
  records.forEach(r => {
    console.log(r.time + '  ' + r.name +
      '  total=' + r.total +
      '  exec=' + (r.exec === null ? '-' : r.exec) +
      '  n=' + (r.n === null ? '-' : r.n))
  })

  // 按名字分组，冷启动（n=1）单独算，否则会把热调用的中位数拉高
  const groups = {}
  records.forEach(r => {
    if (!groups[r.name]) groups[r.name] = { cold: [], warm: [] }
    ;(r.n === 1 ? groups[r.name].cold : groups[r.name].warm).push(r.total)
  })

  console.log('--- 汇总（中位数）---')
  Object.keys(groups).forEach(name => {
    const g = groups[name]
    console.log(name +
      '  热=' + (median(g.warm) === null ? '-' : median(g.warm) + 'ms') +
      ' (' + g.warm.length + '次)' +
      '  冷=' + (median(g.cold) === null ? '-' : median(g.cold) + 'ms') +
      ' (' + g.cold.length + '次)')
  })
  console.log('提示：把「热」那一列抄进表格。ping 的热值就是链路开销的下限。')
}

module.exports = {
  timedCall: timedCall,
  timedDb: timedDb,
  report: report,
  records: records
}
