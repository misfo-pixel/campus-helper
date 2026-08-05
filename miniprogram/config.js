// 全局功能开关。
//
// 外卖拼团只剩买家端两页留在仓库里，提审期间不让审核员走到。
// 想恢复外卖，做三件事：
//   1. 把下面 FOOD_MODULE_ENABLED 改成 true
//   2. 把这两行加回 app.json 的 pages 数组：
//        "pages/index/index"        （外卖拼团首页）
//        "pages/myorders/myorders"  （我的外卖订单）
//   3. 把 project.config.json 的 packOptions.ignore 里对应的两条 folder 删掉
//      （提审期间这些页面留在仓库里但不打进上传包）
//
// ⚠️ 恢复前务必先把「上传付款截图 + 管理员确认收款」那套换掉。
// 引导用户走微信支付以外的方式付钱是明确违规的，带着这套提审必被驳回。
// 见 pages/myorders/myorders.js 的 uploadProof。
//
// 管理端（pages/admin + pages/summary + getPendingOrders/getConfirmedOrders 云函数）
// 已删除：它整个就是那套违规流程的执行端，换掉付款方式后也没有复用价值。
// 汇总清单的两张表已迁到 pages/teammanifest；需要时从 git 历史取回。
const FOOD_MODULE_ENABLED = false

// 校园餐厅（商家自营）：买家端 + 商家端都已完成，所以默认开着。
//
// 开着意味着首页会出现「校园餐厅」入口，提审时这个模块会被审核员看到，
// 相应地就需要餐饮相关的服务类目。如果你想先提交一个不含外卖的版本，
// 把这里改成 false 就行——入口全部消失，其余四个模块不受影响。
//
// 平台不经手资金：订单里没有支付状态，买家按商家填的收款方式在小程序外
// 自行转账，商家收到钱后在工作台点「接单」。
const SHOP_MODULE_ENABLED = true

module.exports = {
  FOOD_MODULE_ENABLED: FOOD_MODULE_ENABLED,
  SHOP_MODULE_ENABLED: SHOP_MODULE_ENABLED
}
