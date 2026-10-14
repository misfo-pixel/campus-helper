// 发布成功后的「转发到微信群」引导。数据和审核状态由 utils/publish.js 的 guideShare 填，
// 页面里放一个 <share-guide>，把 data.guide 的几项传进来。
//
// 转发按钮是 open-type="share"，点了走的是页面自己的 onShareAppMessage（publish.js 的 guideShareMessage）。
// 「完成」一直在：微信不许强制或诱导分享，引导可以，但不转发也得能走
const { loadDisplayFont } = require('../../utils/fonts.js')

Component({
  properties: {
    show: Boolean,
    status: String,     // reviewing 审核中 / live 已公开，可以转发 / pending 审核没出结果
    headline: String,
    title: String,      // 转发卡片标题
    cover: String,      // 转发卡片封面（本地路径），没有就不画图
    moreText: String    // 第二个出口，比如二手的「再发一件」；不填就只有「完成」
  },

  lifetimes: {
    attached: function () {
      loadDisplayFont()   // 大标题用黄油体，没下下来就是系统粗体
    }
  },

  methods: {
    noop: function () {},
    onClose: function () {
      this.triggerEvent('close')
    },
    onMore: function () {
      this.triggerEvent('more')
    }
  }
})
