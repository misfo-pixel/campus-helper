// 二手和转租都有「供」和「求」两面：卖/收、转/找。
// 差异全收敛在这张表里——加新板块或改文案只动这里，四个列表页、两个发布页、三个详情页都不用碰。
const KINDS = {
  item: {
    field: 'kind',
    default: 'sell',
    // label 是胶囊上的字（要短），action 是发布页按钮上的字（要完整），
    // closed 是发布者标了「已售/已租出」之后详情页顶部横幅和「我的发布」列表上的字，
    // open 是帖子还开着时「我的发布」列表上的字
    tabs: [
      { key: 'sell', label: '出', action: '我要出售', empty: '还没有商品，来发布第一个吧', closed: '已售出', open: '在售' },
      // 求购帖点的也是那个「标记已售」，但写「已售出」会让人以为发帖人在卖东西，所以只说结束了；
      // 开着的时候同理不能写「在售」，用和「已结束」成对的中性说法
      { key: 'want', label: '收', action: '我要求购', empty: '还没有人发求购，来发第一条吧', closed: '已结束', open: '进行中' }
    ]
  },
  sublet: {
    field: 'kind',
    default: 'offer',
    tabs: [
      { key: 'offer', label: '转', action: '我要转租', empty: '还没有房源，来发布第一个吧', closed: '已租出', open: '出租中' },
      { key: 'seek', label: '找', action: '我要找房', empty: '还没有人发求租，来发第一条吧', closed: '已结束', open: '进行中' }
    ]
  }
}

// 「求」那一面（求购/求租）通常没有实拍图，走文字列表布局；
// 「供」那一面有图，走原来的图片布局。
const DEMAND_KINDS = ['want', 'seek']

function isDemand(kind) {
  return DEMAND_KINDS.indexOf(kind) !== -1
}

// 转租帖的月租只有一个数 rent；求租帖的预算是区间 rent_min / rent_max。
// 改版前发的求租帖也只有 rent，所以没有区间就退回 rent。
// 只返回数字部分，「$」「预算」「/月」由各处自己拼——列表、详情、转发标题的说法不一样
function rentText(doc) {
  if (doc.rent_min == null || doc.rent_max == null) return String(doc.rent)
  if (doc.rent_min === doc.rent_max) return String(doc.rent_min)
  return doc.rent_min + '-' + doc.rent_max
}

// 帖子已经关掉的几种状态：卖掉 / 租出 / 完成是发布者自己标的，过期是 autoExpire 按日期下的架。
// 列表页只查 on_sale / open，所以这些帖子只会从群里的旧转发卡片、「我的发布」点进详情页。
const CLOSED_STATUS = ['sold', 'rented', 'done', 'expired']
const EXPIRED_LABEL = '已过期'   // 系统按日期下的架，不分供求，也不代表东西真的出手了
const TASK_CLOSED_LABEL = '已完成'   // 委托只有一面，没有供/求，不在上面那张表里
const TASK_OPEN_LABEL = '进行中'

function isClosed(status) {
  return CLOSED_STATUS.indexOf(status) !== -1
}

function tabOf(cfg, doc) {
  const kind = doc.kind || cfg.default   // 早期的帖子没有 kind 字段，都是「供」那一面
  return cfg.tabs.filter(t => t.key === kind)[0]
}

// 先发后审（utils/publish.js）多出来的两个状态。它们不算「关掉」（isClosed 仍是 false，
// 转发标题不会写【已结束】），但同样不在列表里公开，详情页也只有发布者自己能打开。
const REVIEW_LABEL = { reviewing: '审核中', rejected: '未通过审核' }

// 横幅下面那行小字。审核中的帖子别人看不到，原来那句「别人点开时也会先看到这一条」就不对了
function reviewHint(doc) {
  if (!doc) return ''
  if (doc.status === 'reviewing') return '通常几秒内自动公开，审核通过前只有你自己看得到'
  if (doc.status === 'rejected') return (doc.reject_reason || '内容可能违规') + '，只有你自己看得到'
  return ''
}

// 详情页顶部横幅、「我的发布」列表上的字；帖子还开着就返回空串，详情页拿它直接当 wx:if 的开关
function closedLabel(type, doc) {
  if (doc && REVIEW_LABEL[doc.status]) return REVIEW_LABEL[doc.status]
  if (!doc || !isClosed(doc.status)) return ''
  if (doc.status === 'expired') return EXPIRED_LABEL
  const cfg = KINDS[type]
  if (!cfg) return TASK_CLOSED_LABEL
  const tab = tabOf(cfg, doc)
  return tab ? tab.closed : '已结束'
}

// 「我的发布」列表上还开着的帖子显示的字。这里不看 status——
// 列表页先问 closedLabel，拿到空串才轮到它，关没关只在 closedLabel 一处判断
function openLabel(type, doc) {
  const cfg = KINDS[type]
  if (!cfg) return TASK_OPEN_LABEL
  const tab = tabOf(cfg, doc || {})
  return tab ? tab.open : '进行中'
}

module.exports = {
  KINDS: KINDS,
  isDemand: isDemand,
  rentText: rentText,
  isClosed: isClosed,
  closedLabel: closedLabel,
  reviewHint: reviewHint,
  openLabel: openLabel
}
