// 配送请求的「哪一场、送哪、几单、多少钱」怎么显示。店长的「找配送队」页和
// 配送队工作台显示的是同一句话，所以放这儿。
//
// 请求上的字段（deliveryRequest 云函数）：
//   batch_date / depart_time  哪一场、几点出发
//   address_type  'exact' 送上门 / 'points' 送到取货点
//   lines         [{ name, fee, count, arrive }]，arrive 是这个点约几点到
//   total         合计
// 没办完的请求，单数是云函数按订单现数刷新过的。
// 2026-10-10 之前发出的请求没有这些字段，全部返回空串，界面上就不显示这几行。

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return '$' + (v % 1 === 0 ? String(v) : v.toFixed(2))
}

// '2026-10-19' + '12:00' → '10-19 周日 12:00 出发'。
// 补 T12:00:00 再解析：直接 new Date('2026-10-19') 走 UTC，明尼苏达会倒退一天
function departText(date, depart) {
  if (!date || !depart) return ''
  const d = new Date(date + 'T12:00:00')
  const week = isNaN(d.getTime()) ? '' : ' ' + WEEK[d.getDay()]
  return date.slice(5) + week + ' ' + depart + ' 出发'
}

// 一个点一行：「Coffman 门口 · 约 12:15 到 · 3 单」
function lineText(l) {
  return l.name + (l.arrive ? ' · 约 ' + l.arrive + ' 到' : '') + ' · ' + l.count + ' 单'
}

function describe(q) {
  const lines = (q && q.lines) || []
  const when = departText(q && q.batch_date, q && q.depart_time)
  if (!lines.length) return { tag: '', detail: '', totalText: '', departText: when, rows: [] }

  // 取货点是默认情况，不标；只有送上门（现在关着）才挂个标签区分
  const exact = q.address_type === 'exact'
  return {
    tag: exact ? '送上门' : '',
    detail: exact
      ? '每单 ' + money(lines[0].fee) + ' × ' + lines[0].count + ' 单'
      : lines.map(lineText).join('；'),
    totalText: '合计 ' + money(q.total),
    departText: when,
    rows: lines.map(lineText)
  }
}

module.exports = {
  money: money,
  departText: departText,
  lineText: lineText,
  describe: describe
}
