// 三个详情页（二手 / 转租 / 委托）的转发卡片：标题模板 + 封面预下载。
//
// 卡片在群里只露一行半标题，群友扫一眼就决定点不点。所以标题按「群友先筛什么」排：
//   【动作】东西 价钱 · 时间
//   【出】宜家书桌 九成新 $30
//   【收】二手自行车 预算$100
//   【转】Radius 单间 $1200/月 · 12/15-5/31
//   【找】Dinkytown 单间 预算$900/月 · 1/1-5/31
//   【有偿】帮取 Amazon 快递 $10 · 9/20前
// 谁都能转发别人的帖子，所以一律第三人称，不写「我」。

const { KINDS, isDemand, isClosed, rentText } = require('./kinds.js')
const { toLocalPath } = require('./poster.js')

const TASK_TAG = '有偿'    // 委托只有一面，没有供/求之分，突出「给钱」最能让人点进来
const TITLE_MAX = 14       // 卡片标题两行就截断，用户标题太长会把价钱和日期挤掉

// 用户自己常在标题里写「出 」「求 」，前面已经有【出】【找】了，去掉免得重复。
// 后面必须跟分隔符或括号才去——「转角沙发」「收纳箱」是东西本身，不能被吃掉。
const LEADING_TAG = /^[【\[（(]?(出|收|转租|转|找|求租|求购|求|有偿)(?:[】\]）)]\s*|[\s:：、|｜·/]+)/

const DETAIL = {
  item: '/pages/itemdetail/itemdetail',
  sublet: '/pages/subletdetail/subletdetail',
  task: '/pages/taskdetail/taskdetail'
}

// 详情还没加载出来就点了转发，只能先转发列表页
const FALLBACK = {
  item: { title: '明尼助手 · 二手市场', path: '/pages/market/market' },
  sublet: { title: '明尼助手 · 房屋转租', path: '/pages/subletmarket/subletmarket' },
  task: { title: '明尼助手 · 帮个忙', path: '/pages/taskmarket/taskmarket' }
}

function clip(s, n) {
  const chars = Array.from(String(s || '').trim())   // 按字符切，不会把 emoji 切成半个
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('')
}

// '2026-12-15' → '12/15'
function monthDay(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date || '')
  return m ? Number(m[1]) + '/' + Number(m[2]) : ''
}

function today() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 出/收/转/找 直接用 kinds.js 里胶囊上的字，和列表页说法一致
function tagOf(type, doc) {
  const cfg = KINDS[type]
  if (!cfg) return TASK_TAG
  const kind = doc.kind || cfg.default
  const tab = cfg.tabs.filter(t => t.key === kind)[0]
  return tab ? tab.label : ''
}

function shareTitle(type, doc) {
  const name = clip(String(doc.title || '').replace(LEADING_TAG, ''), TITLE_MAX)
  // 已经卖掉/租出/完成/过期的，转发出去不该还在吆喝
  if (isClosed(doc.status)) return '【已结束】' + name

  const tag = '【' + tagOf(type, doc) + '】'
  const money = isDemand(doc.kind) ? ' 预算$' : ' $'

  if (type === 'sublet') {
    const range = [monthDay(doc.start_date), monthDay(doc.end_date)].filter(Boolean).join('-')
    return tag + name + money + rentText(doc) + '/月' + (range ? ' · ' + range : '')
  }
  if (type === 'task') {
    // 截止日已过但没人标完成的，不写日期，免得看着像过期帖
    const due = doc.deadline && doc.deadline >= today() ? ' · ' + monthDay(doc.deadline) + '前' : ''
    return tag + name + money + doc.reward + due
  }
  return tag + name + money + doc.price
}

// 封面要在点转发之前就下到本地。
// 直接把 cloud:// 交给微信也能用，但那是点了转发才开始下载——云存储在国内，
// 跨太平洋拉一张图要好几秒，卡片就一直出不来。下到本地后，点转发时不用走网络。
//
// 发帖人转自己的帖子是在打广告，用原图保证清晰；
// 别人打开详情页的次数多得多，大多也不转发，给他们下原图就是每次白花几百 KB，
// 所以用 30KB 的缩略图，老数据没有缩略图再退回原图。
function prefetchCover(doc, isOwner) {
  const images = (doc && doc.images) || []
  const src = isOwner ? images[0] : (doc && doc.thumb) || images[0]
  return toLocalPath(src)
}

// onShareAppMessage 里直接 return 这个。cover 是 prefetchCover 返回的 Promise。
//
// 微信最多等 promise 3 秒，超时就用外层这份——imageUrl 还是 cloud://，
// 也就是原来那条「点了才下载」的慢路，至少不会没图。
function detailShare(type, doc, cover) {
  if (!doc) return Object.assign({}, FALLBACK[type])

  const msg = { title: shareTitle(type, doc), path: DETAIL[type] + '?id=' + doc._id }
  return withCover(msg, (doc.images && doc.images[0]) || '', cover)
}

// 给任意一张转发卡片挂上预下载好的封面。详情页、「我的闲置」、个人主页共用。
// fileID 是云存储原图，cover 是它（或它的缩略图）下到本地的 Promise
function withCover(msg, fileID, cover) {
  // 没图（求购、求租、多数委托）就不给 imageUrl，微信会截页面顶部当封面
  if (!fileID) return msg
  return Object.assign({}, msg, {
    imageUrl: fileID,
    promise: (cover || Promise.resolve('')).then(local =>
      Object.assign({}, msg, { imageUrl: local || fileID }))
  })
}

module.exports = {
  clip: clip,                  // 店铺页的转发标题在 shopdetail 自己拼，借这里的按字符裁剪
  prefetchCover: prefetchCover,
  detailShare: detailShare,
  withCover: withCover,
  shareTitle: shareTitle
}
