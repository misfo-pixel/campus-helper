// 免责声明条。买家端和店长端都挂这个，type 决定说哪一套。
//
// 2026-09-20 改成默认「一行灰字 + 详情」：原来每个板块一个黄框、四五行，
// 全小程序十几处，用户翻到第三个就自动忽略了——铺得越满越没人看。
// 现在只有真正需要当场读完的地方（开店时勾协议那一屏）传 full，
// 其余都是一行 brief，全文照旧在 pages/agreement 和 pages/shopagreement。
//
// 2026-09-24 brief 再压短，统一成「明尼助手只展示信息，不 X」：X 只挑这类页面最要紧的那一条，
// 其余靠「详情」。各详情页都把它放在页面最后一行。

const { t } = require('../../i18n/index.js')
const TEXTS = {
  // 买家：浏览店铺、看商品、下单时
  buyer: {
    brief: t('明尼助手只展示信息，不经手资金'),
    title: t('下单前请注意'),
    lines: [
      t('本平台不是经营者，不制作、不配送、不参与交易，仅展示店长自行发布的信息。'),
      t('商品、价格、配送时间、安全与质量均由店长负责，平台不审核、不作任何保证。'),
      t('平台只记录下单意向，不参与交易、不经手资金、不提供担保、不处理退款。'),
      t('有食物过敏或其他特殊需求，请务必下单前直接向店长确认。')
    ],
    link: '/pages/agreement/agreement'
  },

  // 入驻申请页
  apply: {
    brief: t('平台不做事前审核，提交即开店，内容合规完全由你负责'),
    title: t('开店前请确认'),
    lines: [
      t('平台不做事前审核，提交即开店——内容是否合规完全由你负责。'),
      t('你必须自行确保具备当地法律要求的经营资质，并对商品与服务安全承担全部责任。'),
      t('被举报并核实违规的店铺会被强制关停，且无法自行恢复营业。')
    ],
    link: '/pages/shopagreement/shopagreement'
  },

  // 二手物品详情
  trade: {
    brief: t('明尼助手只展示信息，不担保交易'),
    title: t('交易提示'),
    lines: [
      t('本平台仅展示用户自行发布的信息，不参与交易、不担保物品真实性和质量、不经手任何资金。'),
      t('请当面验货后再付款，尽量约在公共场所交易。'),
      t('警惕要求先转账、先付定金的对方，因此产生的损失平台无法追回。')
    ],
    link: '/pages/agreement/agreement'
  },

  // 转租房源详情
  sublet: {
    brief: t('明尼助手只展示信息，不核实房源'),
    title: t('租房提示'),
    lines: [
      t('本平台不是房产中介，不提供中介服务，不核实房源真实性，不参与签约。'),
      t('转租通常需要房东或公寓方书面同意，请自行确认你的租约条款，否则可能违约。'),
      t('签约和付款前请实地看房、核实对方身份与租约，押金和租金风险由你自行承担。')
    ],
    link: '/pages/agreement/agreement'
  },

  // 委托任务详情
  task: {
    brief: t('明尼助手只展示信息，不是用工方'),
    title: t('委托提示'),
    lines: [
      t('本平台不是用工方、不派单、不抽成，只展示用户自行发布的信息。'),
      t('报酬、时间、责任划分由双方自行约定，平台不介入纠纷。'),
      t('涉及人身安全、贵重物品或需要专业资质的委托，请务必谨慎并核实对方身份。')
    ],
    link: '/pages/agreement/agreement'
  },

  // 群组详情
  group: {
    brief: t('明尼助手只展示信息，不组织活动'),
    title: t('组队提示'),
    lines: [
      t('本平台不组织、不赞助任何活动，也不管理任何群，只展示用户自行发布的信息。'),
      t('群和活动由发起人自行负责，平台与其不存在任何合作或代表关系。'),
      t('线下见面请约在公共场所，涉及拼车、合租、AA 付款时务必核实对方身份。')
    ],
    link: '/pages/agreement/agreement'
  },

  // 各类发布页
  publish: {
    brief: t('内容由你负责，微信号会公开展示'),
    title: t('发布须知'),
    lines: [
      t('你对发布内容的真实性、合法性负责，请勿发布虚假、违法或侵犯他人权益的信息。'),
      t('你填写的微信号会公开展示给其他用户，请只填写你愿意公开的联系方式。'),
      t('内容会经过安全检测，被举报并核实违规的内容将被删除。')
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
