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

module.exports = {
  today: today,
  formatTime: formatTime
}
