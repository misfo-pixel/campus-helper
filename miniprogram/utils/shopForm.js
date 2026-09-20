// 开店向导（pages/shopcreate）和小店设置（pages/shopedit）共用的那部分。
//
// 两个页面现在是分开的：向导是一步步问，设置是一张长表单随便改。
// 但分类口径、老数据映射、图片上传这三件事必须一致，所以抽到这里，
// 免得改了一边忘了另一边。

// 分类要能容下非餐饮店长（代购、生活服务），别把模块绑死在餐饮上。
const CATEGORIES = ['美食', '饮品甜点', '日用百货', '生活服务', '其他']

// 第一版分类全是餐饮口径，老店铺库里存的还是那批值。不映射的话
// indexOf 返回 -1 会静默退回第一项——店长一保存，分类就被悄悄改掉了。
const LEGACY_CATEGORY = {
  '中餐': '美食',
  '快餐简餐': '美食',
  '奶茶饮品': '饮品甜点',
  '烘焙甜点': '饮品甜点'
}

// 把库里存的分类值定位到 CATEGORIES 的下标。认不出来的归到「其他」，
// 而不是第一项——静默改成「美食」比归到「其他」糟得多。
function categoryIndexOf(value) {
  const idx = CATEGORIES.indexOf(LEGACY_CATEGORY[value] || value)
  return idx === -1 ? CATEGORIES.length - 1 : idx
}

// 选图时只拿到本地临时路径，提交时才真的传。
// 没换图（temp 为空）就把原来的云文件 ID 原样返回，别重复上传。
function uploadShopImage(tempPath, saved, dir) {
  if (!tempPath) return Promise.resolve(saved || '')

  const match = tempPath.match(/\.(\w+)$/)
  const ext = match ? match[1] : 'jpg'
  const cloudPath = dir + '/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath }).then(r => r.fileID)
}

// 自送时的方案校验。两个页面的提交前检查是同一套，返回第一条错，null = 通过。
function validatePlan(points, batches) {
  const kept = (points || []).filter(p => String(p.name || '').trim())
  if (!kept.length) return '自己送的话，至少要设一个服务地点'

  const names = kept.map(p => p.name.trim())
  if (new Set(names).size !== names.length) return '服务地点名字不能重复'

  // 日期只校验填没填，不校验是不是过去的日子——否则场次一过期，
  // 店长连改商品、改联系方式都保存不了。
  const batch = (batches || [])[0]
  if (!batch || !batch.date) return '请选择服务时间的日期'
  if (batch.deliver_time <= batch.cutoff) return '送达时间要晚于截单时间'
  return null
}

module.exports = {
  CATEGORIES: CATEGORIES,
  LEGACY_CATEGORY: LEGACY_CATEGORY,
  categoryIndexOf: categoryIndexOf,
  uploadShopImage: uploadShopImage,
  validatePlan: validatePlan
}
