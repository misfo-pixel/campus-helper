// 延迟测量的对照组。
//
// 它不查库、不调接口、不做任何业务，所以它的耗时就是「链路开销的下限」：
// 微信客户端 → 微信接入点 → 跨太平洋 → 云函数平台调度 → 原路返回。
// 业务云函数比它慢多少，才是你自己代码和数据库的锅。
//
// 冷启动检测的原理：模块顶层的代码在实例启动时只执行一次，之后每次调用
// 只跑 exports.main。所以 n === 1 就意味着这次打到了全新实例——
// 这是客观判据，比「我大概闲置够久了吧」可靠得多。
const INSTANCE = Math.random().toString(36).slice(2, 8)
const BOOTED_AT = Date.now()
let n = 0

exports.main = async () => {
  const t0 = Date.now()
  n += 1
  return {
    ok: true,
    _debug: {
      instance: INSTANCE,
      n: n,
      instanceAgeMs: t0 - BOOTED_AT,
      execMs: Date.now() - t0,
      serverNow: t0
    }
  }
}
