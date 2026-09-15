// 定时保温：每 5 分钟把常用云函数各调一次，防止容器被回收。
//
// 背景：云函数闲置一段时间后平台会回收容器，下次调用要重新启动，实测多花
// 400~800ms。跨太平洋的场景下这个代价更明显，因为它叠在本来就有的链路开销上。
//
// ⚠️ 冷启动是「按函数」算的——每个云函数有自己的容器池。保温 ping 不会让
// getDetail 变热。所以这里要点名那些真正会被用户调用的函数。
//
// 触发器配置在 config.json 里，cron 是 7 位（秒 分 时 日 月 周 年）。
// 改完要右键这个函数 →「上传触发器」，只上传代码不会创建触发器。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 用户路径上最常被调用的几个。冷门函数不值得保温——每保一个都是持续的调用次数。
const TARGETS = ['login', 'getDetail', 'getUserStore']

exports.main = async () => {
  const results = await Promise.all(TARGETS.map(name =>
    cloud.callFunction({ name: name, data: { __warmup: true } })
      .then(() => ({ name: name, ok: true }))
      .catch(err => ({ name: name, ok: false, error: String(err) }))
  ))
  console.log('保温结果：', JSON.stringify(results))
  return { warmed: results }
}
