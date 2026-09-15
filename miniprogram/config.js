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

// 校外服务（商家自营）：买家端 + 商家端都已完成，所以默认开着。
//
// 开着意味着首页会出现「校外服务」入口，提审时这个模块会被审核员看到，
// 相应地就需要餐饮相关的服务类目。如果你想先提交一个不含外卖的版本，
// 把这里改成 false 就行——入口全部消失，其余四个模块不受影响。
//
// 平台不经手资金：订单里没有支付状态，买家按商家填的收款方式在小程序外
// 自行转账，商家收到钱后在工作台点「接单」。
//
// 首次提审关着：个人主体报不了餐饮类目，而且「在小程序外按商家收款方式付款」
// 跟外卖那套是同一类引导站外支付的问题（见上面 FOOD_MODULE_ENABLED 的说明）。
const SHOP_MODULE_ENABLED = false

// 延迟测量开关。开着的时候：
//   1. 所有被包过的请求都会往 Console 打一行 [timing]
//   2. 市场页底部出现 ping / report 两个测试按钮
//
// ⚠️ 提审前必须改回 false——测试按钮不该被审核员看到。
// 关掉之后 timing 的包装函数会退化成直接透传，没有任何运行开销。
const DEBUG_TIMING = false

module.exports = {
  FOOD_MODULE_ENABLED: FOOD_MODULE_ENABLED,
  SHOP_MODULE_ENABLED: SHOP_MODULE_ENABLED,
  DEBUG_TIMING: DEBUG_TIMING
}
