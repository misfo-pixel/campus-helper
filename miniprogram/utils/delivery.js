// 配送请求的「送哪、几单、多少钱」怎么显示。店长的「找配送队」页和
// 配送队工作台显示的是同一句话，所以放这儿。
//
// 请求上存的是快照（deliveryRequest 的 buildLines）：
//   address_type  'exact' 送上门 / 'points' 送到取货点
//   lines         [{ name, fee, count }]
//   total         合计
// 2026-10-10 之前发出的请求没有这几个字段，全部返回空串，界面上就不显示这一行。

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return '$' + (v % 1 === 0 ? String(v) : v.toFixed(2))
}

function describe(q) {
  const lines = (q && q.lines) || []
  if (!lines.length) return { tag: '', detail: '', totalText: '' }

  const exact = q.address_type === 'exact'
  const detail = exact
    ? '每单 ' + money(lines[0].fee) + ' × ' + lines[0].count + ' 单'
    : lines.map(l => l.name + ' ' + l.count + ' 单').join(' · ')

  return {
    tag: exact ? '送上门' : '送到取货点',
    detail: detail,
    totalText: '合计 ' + money(q.total)
  }
}

module.exports = {
  money: money,
  describe: describe
}
