// 二手和转租都有「供」和「求」两面：卖/收、转/找。
// 差异全收敛在这张表里——加新板块或改文案只动这里，四个列表页和两个发布页都不用碰。
const KINDS = {
  item: {
    field: 'kind',
    default: 'sell',
    // label 是胶囊上的字（要短），action 是发布页按钮上的字（要完整）
    tabs: [
      { key: 'sell', label: '出', action: '我要出售', empty: '还没有商品，来发布第一个吧' },
      { key: 'want', label: '收', action: '我要求购', empty: '还没有人发求购，来发第一条吧' }
    ]
  },
  sublet: {
    field: 'kind',
    default: 'offer',
    tabs: [
      { key: 'offer', label: '转', action: '我要转租', empty: '还没有房源，来发布第一个吧' },
      { key: 'seek', label: '找', action: '我要找房', empty: '还没有人发求租，来发第一条吧' }
    ]
  }
}

// 「求」那一面（求购/求租）通常没有实拍图，走文字列表布局；
// 「供」那一面有图，走原来的图片布局。
const DEMAND_KINDS = ['want', 'seek']

function isDemand(kind) {
  return DEMAND_KINDS.indexOf(kind) !== -1
}

module.exports = {
  KINDS: KINDS,
  isDemand: isDemand
}
