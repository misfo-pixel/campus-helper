// 列表 → 详情的「秒开」交接。
//
// 点进详情页原来是白屏等 getDetail：一趟跨太平洋往返，碰上冷启动还要再加半秒多。
// 可列表里明明已经有标题、价格、图片了——跳转前把这条先放在这里，
// 详情页一打开就拿出来先画首屏，getDetail 回来再补全剩下的。
//
// 为什么放模块变量、不放 URL 参数：URL 有长度限制、中文要编码；
// 小程序里所有页面 require 的是同一份模块，模块变量天然就能跨页面。
// 只放一条、取一次就清空，不会越攒越多，也不会被别的详情页误拿。
let pending = null

// 列表页 goToDetail 里、navigateTo 之前调用。doc 就是列表里那条原始数据
function stashPreview(type, doc) {
  pending = doc && doc._id ? { type: type, id: doc._id, doc: doc } : null
}

// 详情页 onLoad 里调用。拿到的只是列表查出来的那几个字段（有投影），不是完整数据——
// 只能用来画首屏的图片、标题、价格，其他的等 getDetail
function takePreview(type, id) {
  const p = pending
  pending = null
  return p && p.type === type && p.id === id ? p.doc : null
}

// 列表页的通用写法：按 data-id 在当前列表里找到那条，放进来
function stashFrom(type, list, id) {
  stashPreview(type, (list || []).filter(it => it._id === id)[0])
}

module.exports = {
  stashPreview: stashPreview,
  takePreview: takePreview,
  stashFrom: stashFrom
}
