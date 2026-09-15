// 列表页「什么时候该重新拉第一页」的判断。
//
// 背景：加了分页之后，onShow 里无脑 reload 会把用户滑了好几页的进度清掉
// （进详情页再返回就回到第一页）。但也不能永远不刷新——刚发布完一条，
// 返回列表得看得见。
//
// 所以改成：谁改了数据，谁负责打一个标记；列表页在 onShow 里查这个标记。
// 这是「失效驱动」而不是「定时轮询」——只在真的变了的时候才付出一次网络代价。
const STALE_MS = 5 * 60 * 1000   // 兜底：页面在后台放超过 5 分钟，回来还是刷一次

function bag() {
  const app = getApp()
  if (!app.globalData) app.globalData = {}
  if (!app.globalData.staleKeys) app.globalData.staleKeys = {}
  return app.globalData.staleKeys
}

// 发布、删除、改状态之后调用。key 用 'item' / 'sublet' / 'task'
function markStale(key) {
  try {
    bag()[key] = true
  } catch (e) {
    // getApp() 在极早期可能拿不到，标记失败最多是少刷新一次，不该抛
  }
}

// 列表页 onShow 里调用；返回 true 表示该从头拉。
// 标记是「消费掉就清除」的——刷过一次就不该再刷第二次。
function shouldReload(key, loadedAt) {
  if (!loadedAt) return true
  try {
    const b = bag()
    if (b[key]) {
      delete b[key]
      return true
    }
  } catch (e) {
    return false
  }
  return Date.now() - loadedAt > STALE_MS
}

module.exports = {
  markStale: markStale,
  shouldReload: shouldReload
}
