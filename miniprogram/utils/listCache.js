// 列表第一页的本地缓存，给 stale-while-revalidate 用：
// 进页面先把上次存的摆上去，同时后台去拉最新的，回来了再整页换掉。
// 列表数据从国内回到明尼苏达至少一趟太平洋往返，物理延迟省不掉，但首屏不必等它。
//
// 原来只有市场页有（写在 market.js 里），抽出来给各个列表页共用。
// key 的约定：'<页面>.v<版本>.<子键>'，列表结构变了就改版本号，老缓存自然读不到。

// 太旧的不拿出来：一天前的列表里很多已经卖掉了，先闪一屏旧的再大面积替换，比显示「加载中」还难受
const MAX_AGE = 24 * 60 * 60 * 1000

function readCache(key) {
  try {
    const c = wx.getStorageSync(key)
    if (!c || !c.items || Date.now() - c.savedAt > MAX_AGE) return null
    return c.items
  } catch (e) {
    return null   // 存储被禁用或读坏了，当没有缓存
  }
}

// maxSiblings：同前缀（最后一个 . 之前相同）的 key 最多留几个，超了删最旧的。
// 个人主页按 uid 各存一份，不设上限的话逛过多少人就攒多少份
function writeCache(key, items, maxSiblings) {
  try {
    wx.setStorageSync(key, { items: items, savedAt: Date.now() })
    if (maxSiblings) prune(key.slice(0, key.lastIndexOf('.') + 1), maxSiblings)
  } catch (e) {
    // 写不进去只是下次少一次秒开，不影响功能
  }
}

function prune(prefix, max) {
  const keys = wx.getStorageInfoSync().keys.filter(k => k.indexOf(prefix) === 0)
  if (keys.length <= max) return
  keys.map(k => ({ k: k, t: (wx.getStorageSync(k) || {}).savedAt || 0 }))
    .sort((a, b) => a.t - b.t)
    .slice(0, keys.length - max)
    .forEach(x => wx.removeStorageSync(x.k))
}

module.exports = {
  readCache: readCache,
  writeCache: writeCache
}
