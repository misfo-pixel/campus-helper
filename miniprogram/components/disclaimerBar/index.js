// 免责声明条。买家端和店长端都挂这个，type 决定说哪一套。
//
// 2026-09-20 改成默认「一行灰字 + 详情」：原来每个板块一个黄框、四五行，
// 全小程序十几处，用户翻到第三个就自动忽略了——铺得越满越没人看。
// 现在只有真正需要当场读完的地方（开店时勾协议那一屏）传 full，
// 其余都是一行 brief，全文照旧在 pages/agreement 和 pages/shopagreement。

const TEXTS = {
  // 买家：浏览店铺、看商品、下单时
  buyer: {
    brief: '平台只展示信息、记录下单意向，不参与交易、不担保、不经手资金',
    title: '下单前请注意',
    lines: [
      '本平台不是经营者，不制作、不配送、不参与交易，仅展示店长自行发布的信息。',
      '商品、价格、配送时间、安全与质量均由店长负责，平台不审核、不作任何保证。',
      '平台只记录下单意向，不参与交易、不经手资金、不提供担保、不处理退款。',
      '订单里的收款方式由店长自填，平台未验证账户归属，付款前请自行核对。',
      '有食物过敏或其他特殊需求，请务必下单前直接向店长确认。'
    ],
    link: '/pages/agreement/agreement'
  },

  // 店长：工作台顶部常驻
  merchant: {
    brief: '你是独立经营者，资质、商品安全、收款退款、报税都由你自己负责',
    title: '店长责任提示',
    lines: [
      '你是独立经营者，不是本平台的员工、代理或合作方。',
      '经营资质、商品安全、收款退款、纳税申报全部由你自行负责。',
      '请确保你的商品描述、价格和成分信息真实准确；卖食品的必须标注过敏原。'
    ],
    link: '/pages/shopagreement/shopagreement'
  },

  // 入驻申请页
  apply: {
    brief: '平台不做事前审核，提交即开店，内容合规完全由你负责',
    title: '开店前请确认',
    lines: [
      '平台不做事前审核，提交即开店——内容是否合规完全由你负责。',
      '你必须自行确保具备当地法律要求的经营资质，并对商品与服务安全承担全部责任。',
      '被举报并核实违规的店铺会被强制关停，且无法自行恢复营业。'
    ],
    link: '/pages/shopagreement/shopagreement'
  },

  // 二手物品详情
  trade: {
    brief: '平台不参与交易、不担保物品真假，请当面验货后再付款',
    title: '交易提示',
    lines: [
      '本平台仅展示用户自行发布的信息，不参与交易、不担保物品真实性和质量、不经手任何资金。',
      '请当面验货后再付款，尽量约在公共场所交易。',
      '警惕要求先转账、先付定金的对方，因此产生的损失平台无法追回。'
    ],
    link: '/pages/agreement/agreement'
  },

  // 转租房源详情
  sublet: {
    brief: '平台不是房产中介，不核实房源，转租多数需房东书面同意',
    title: '租房提示',
    lines: [
      '本平台不是房产中介，不提供中介服务，不核实房源真实性，不参与签约。',
      '转租通常需要房东或公寓方书面同意，请自行确认你的租约条款，否则可能违约。',
      '签约和付款前请实地看房、核实对方身份与租约，押金和租金风险由你自行承担。'
    ],
    link: '/pages/agreement/agreement'
  },

  // 委托任务详情
  task: {
    brief: '平台不是用工方、不派单、不抽成，报酬和责任由双方自行约定',
    title: '委托提示',
    lines: [
      '本平台不是用工方、不派单、不抽成，只展示用户自行发布的信息。',
      '报酬、时间、责任划分由双方自行约定，平台不介入纠纷。',
      '涉及人身安全、贵重物品或需要专业资质的委托，请务必谨慎并核实对方身份。'
    ],
    link: '/pages/agreement/agreement'
  },

  // 各类发布页
  publish: {
    brief: '你对内容的真实性和合法性负责，填写的微信号会公开展示',
    title: '发布须知',
    lines: [
      '你对发布内容的真实性、合法性负责，请勿发布虚假、违法或侵犯他人权益的信息。',
      '你填写的微信号会公开展示给其他用户，请只填写你愿意公开的联系方式。',
      '内容会经过安全检测，被举报并核实违规的内容将被删除。'
    ],
    link: '/pages/agreement/agreement'
  }
}

Component({
  properties: {
    type: {
      type: String,
      value: 'buyer'
    },
    // 只有开店勾协议那一屏传 true——那是用户真的该停下来读的时刻
    full: {
      type: Boolean,
      value: false
    }
  },

  data: {
    brief: '',
    title: '',
    lines: [],
    link: ''
  },

  observers: {
    type: function (type) {
      const t = TEXTS[type] || TEXTS.buyer
      this.setData({ brief: t.brief, title: t.title, lines: t.lines, link: t.link })
    }
  },

  methods: {
    openFull: function () {
      wx.navigateTo({ url: this.data.link })
    }
  }
})
