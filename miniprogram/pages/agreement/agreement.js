const { SHOP_MODULE_ENABLED } = require('../../config.js')

Page({
  data: {
    // 商家模块关着的版本里，协议不该出现店铺和站外付款的条款，后面两节的序号跟着前移
    shopEnabled: SHOP_MODULE_ENABLED
  }
})
