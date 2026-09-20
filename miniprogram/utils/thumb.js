// 列表页用的缩略图。
//
// 列表卡片只有 140~300rpx 高，拿原图（压缩后也有几百 KB）去填是纯浪费：
// 云存储在国内，跨太平洋带宽本来就紧，一屏十几张原图就是好几 MB。
// 发布时顺手把首图缩成 480px 宽另存一份，列表只下载这张，大约 30KB。

const THUMB_WIDTH = 480   // 市场页半屏卡片在 3x 屏上约 500 物理像素，够用

// 生成并上传首图的缩略图，返回 fileID。
// 尽力而为：任何一步失败都返回 ''，列表会退回用原图，不能因为缩略图卡住发布。
// 不单独过内容检测——它是 images[0] 缩出来的，原图已经检过。
function uploadThumb(tempPath, dir) {
  if (!tempPath) return Promise.resolve('')
  return new Promise(resolve => {
    wx.compressImage({
      src: tempPath,
      quality: 60,
      compressedWidth: THUMB_WIDTH,   // 基础库 2.26 起支持，老版本会忽略，只降质量
      success: r => resolve(r.tempFilePath),
      fail: () => resolve('')
    })
  }).then(path => {
    if (!path) return ''
    return wx.cloud.uploadFile({
      cloudPath: dir + '/thumb_' + Date.now() + '.jpg',
      filePath: path
    }).then(r => r.fileID)
  }).catch(err => {
    console.error('缩略图生成失败，列表将退回原图：', err)
    return ''
  })
}

// 列表里该显示哪张图：有缩略图用缩略图，老数据没有就用首图原图
function thumbOf(doc) {
  return (doc && (doc.thumb || (doc.images && doc.images[0]))) || ''
}

module.exports = {
  uploadThumb: uploadThumb,
  thumbOf: thumbOf
}
