// 画图小工具：拿 canvas 节点、云文件转本地、加载图片、圆角、省略号、按 aspectFill 裁图。
// 海报本身怎么画在 utils/groupCover.js（拼团和二手共用）。

// canvas 2d 的节点要通过选择器异步拿，不能像 DOM 那样直接引用
function getCanvasNode(selector, component) {
  return new Promise((resolve, reject) => {
    const q = component ? component.createSelectorQuery() : wx.createSelectorQuery()
    q.select(selector).fields({ node: true, size: true }).exec(res => {
      if (!res || !res[0] || !res[0].node) return reject(new Error('找不到 canvas 节点'))
      resolve(res[0].node)
    })
  })
}

// 云存储的 fileID 不能直接喂给 canvas，要先下载成本地临时文件。
// 任何一张图挂了都不该让整张海报失败，所以失败返回空字符串。
function toLocalPath(fileID) {
  if (!fileID) return Promise.resolve('')
  if (fileID.indexOf('cloud://') !== 0) return Promise.resolve(fileID)
  return wx.cloud.downloadFile({ fileID: fileID })
    .then(r => r.tempFilePath)
    .catch(() => '')
}

function loadImage(canvas, src) {
  if (!src) return Promise.resolve(null)
  return new Promise(resolve => {
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)   // 同上：单张失败就画占位，不中断
    img.src = src
  })
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// canvas 没有「文字溢出省略号」这种东西，得自己一个字一个字量宽度
function ellipsis(ctx, text, maxWidth) {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1)
  }
  return s + '…'
}

// 图片按 aspectFill 裁进目标框：短边铺满，长边居中裁掉多余部分
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height)
  const sw = w / scale
  const sh = h / scale
  const sx = (img.width - sw) / 2
  const sy = (img.height - sh) / 2
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

module.exports = {
  toLocalPath: toLocalPath,
  // 拼团和二手的转发卡片、长图海报（utils/groupCover.js）用的画图小工具
  getCanvasNode: getCanvasNode,
  loadImage: loadImage,
  roundRect: roundRect,
  ellipsis: ellipsis,
  drawCover: drawCover
}
