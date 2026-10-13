// 开店向导（pages/shopcreate）和小店设置（pages/shopedit）共用的那部分。
//
// 两个页面现在是分开的：向导是一步步问，设置是一张长表单随便改。
// 但图片上传、方案校验这些必须一致，所以抽到这里，
// 免得改了一边忘了另一边。

// 选图时只拿到本地临时路径，提交时才真的传。
// 没换图（temp 为空）就把原来的云文件 ID 原样返回，别重复上传。
function uploadShopImage(tempPath, saved, dir) {
  if (!tempPath) return Promise.resolve(saved || '')

  const match = tempPath.match(/\.(\w+)$/)
  const ext = match ? match[1] : 'jpg'
  const cloudPath = dir + '/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath }).then(r => r.fileID)
}

// 取货点校验，两个页面共用。返回第一条错，null = 通过。
// 场次不在这里校验了：2026-10-11 起场次在「我的小店」开团时设（pages/shopsession）
function validatePoints(points) {
  const kept = (points || []).filter(p => String(p.name || '').trim())
  if (!kept.length) return '至少设一个取货点'

  const names = kept.map(p => p.name.trim())
  if (new Set(names).size !== names.length) return '取货点名字不能重复'
  return null
}

module.exports = {
  uploadShopImage: uploadShopImage,
  validatePoints: validatePoints
}
