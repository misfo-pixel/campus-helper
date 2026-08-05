// 免责声明条。买家端和商家端都挂这个，type 决定说哪一套。
//
// 这里放的是「摘要 + 跳完整版」，不是全文——全文在 pages/agreement 和
// pages/shopagreement 里。摘要要短到用户真的会看，完整版负责说全。

const TEXTS = {
  // 买家：浏览店铺、看菜单、下单时
  buyer: {
    title: '下单前请注意',
    lines: [
      '本平台不是餐饮经营者，不制作、不配送、不参与交易，仅展示商家自行发布的信息。',
      '菜品、价格、配送时间、食品安全均由商家负责，平台不作任何保证。',
      '付款由你与商家在平台外自行完成，平台不经手资金、不提供担保、不处理退款。',
      '有过敏原或特殊饮食需求，请务必下单前直接向商家确认。'
    ],
    link: '/pages/agreement/agreement'
  },

  // 商家：工作台顶部常驻
  merchant: {
    title: '商家责任提示',
    lines: [
      '你是独立经营者，不是本平台的员工、代理或合作方。',
      '食品安全、经营资质、收款退款、纳税申报全部由你自行负责。',
      '请确保你的菜品描述、价格和过敏原信息真实准确。'
    ],
    link: '/pages/shopagreement/shopagreement'
  },

  // 入驻申请页
  apply: {
    title: '入驻前请确认',
    lines: [
      '平台只提供信息展示和订单记录，不参与你的经营活动，也不为你的经营行为背书。',
      '你必须自行确保具备当地法律要求的食品经营资质，并对食品安全承担全部责任。',
      '禁止销售酒精、大麻及任何法律限制或禁止销售的商品。'
    ],
    link: '/pages/shopagreement/shopagreement'
  },

  // 二手物品详情
  trade: {
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
    }
  },

  data: {
    title: '',
    lines: [],
    link: ''
  },

  observers: {
    type: function (type) {
      const t = TEXTS[type] || TEXTS.buyer
      this.setData({ title: t.title, lines: t.lines, link: t.link })
    }
  },

  methods: {
    openFull: function () {
      wx.navigateTo({ url: this.data.link })
    }
  }
})
