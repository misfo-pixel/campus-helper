// 骨架屏：数据回来之前，先用灰块把页面的样子画出来，回来后原位换成真内容，页面不跳。
// 每种 type 照着一类真实卡片的尺寸画（尺寸写在 index.wxss），那类卡片改了布局这里要跟着改：
//   grid        两列商品卡（二手在卖）                     —— app.wxss .goods-card
//   row         左图右文卡（转租、小店列表、个人主页、商品管理） —— thumb 传图的边长 rpx
//   text        纯文字卡（求购、求租、委托、群组、订单…）       —— app.wxss .text-card-*
//   detail      大图 + 详情（二手、转租详情）                —— app.wxss .detail-sheet
//   detail-text 无大图的详情（委托、群组详情）
//   shop        店铺详情：店头 + 商品行
//   form        店长 / 配送队后台：标题 + 几张卡
Component({
  properties: {
    type: { type: String, value: 'text' },
    count: { type: Number, value: 4 },
    thumb: { type: Number, value: 200 }
  },

  data: {
    rows: [0, 1, 2, 3]
  },

  observers: {
    count: function (n) {
      this.setData({ rows: Array.from({ length: n }, (_, i) => i) })
    }
  }
})
