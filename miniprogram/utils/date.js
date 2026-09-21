// 日期工具。
//
// 全项目的日期字段（起租日、下架日、取餐场次）都存成 'YYYY-MM-DD' 字符串，
// 不存 Date 也不存时间戳——这样比较大小直接用字符串比就行，
// 云函数那边（autoExpire）也是同一套格式，两边判断才对得上。
//
// 本来这个函数在四个地方各抄了一份（planEditor、subletpublish、
// share.js、shopdashboard），统一到这里。

// 本地时区的今天，'YYYY-MM-DD'。
// 注意不能用 toISOString().slice(0, 10)——那个走 UTC，
// 明尼苏达是 UTC-5/-6，晚上 7 点之后就会算成明天。
function today() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 时间戳 / Date → '9-20 14:05'。
// 月份不补零、日补零，是原来多数页面的写法；统一成这一种。
// 带上日期而不是只给时分：好几个列表（工作台已完成、举报、反馈）
// 都能翻到前几天的记录，光一个 14:05 分不出是哪天的。
function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 'YYYY-MM-DD' → '9-19 周六'。
// 「可配送时段」用：只给日期的话，店长还得自己去翻日历才知道是周几，
// 而约时间的人脑子里想的就是「周六晚上」。
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dateText(value) {
  const s = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // 补上 T12:00:00 再解析：直接 new Date('2026-09-19') 走的是 UTC，
  // 明尼苏达这边会倒退成前一天，周几就错了。选中午是为了躲开夏令时那一小时。
  const d = new Date(s + 'T12:00:00')
  if (isNaN(d.getTime())) return s
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + WEEK[d.getDay()]
}

// { date, start, end } → '9-19 周六 18:00-20:00'。
// 配送工作台（队长自己看）和找配送队（店长看）显示的是同一句话，所以放这儿。
function slotText(slot) {
  if (!slot || !slot.date) return ''
  return dateText(slot.date) + ' ' + slot.start + '-' + slot.end
}

module.exports = {
  today: today,
  formatTime: formatTime,
  dateText: dateText,
  slotText: slotText
}
