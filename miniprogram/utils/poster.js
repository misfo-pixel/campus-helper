// 把用户主页画成一张可保存、可转发的图片。
//
// 为什么要画图：转发卡片只能带一张已有的图；朋友圈更是只能发图片。
// 海报把「头像 + 昵称 + 几件商品 + 小程序码」拼成一张自解释的图，
// 脱离小程序也看得懂，这是唯一能进朋友圈的形态。

const W = 600     // 画布逻辑宽（不是像素宽，见下面的 dpr）
const H = 900
const MAROON = '#7A0019'

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

/**
 * @param {object} opts
 *   selector  canvas 的选择器，如 '#posterCanvas'
 *   component 在自定义组件里调用时传 this，页面里传 null
 *   nickname  昵称
 *   avatar    头像 fileID
 *   items     [{ image, price }]，最多取前 4 件
 *   qrFileID  小程序码 fileID，没有就画文字提示
 * @returns Promise<string> 生成好的图片临时路径
 */
function buildPoster(opts) {
  return getCanvasNode(opts.selector, opts.component).then(canvas => {
    const ctx = canvas.getContext('2d')

    // 手机屏幕是高分屏：逻辑上 600 宽，实际要画 600 × dpr 个像素，
    // 否则图糊。scale 之后后面的坐标仍然按逻辑尺寸写。
    const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    const cells = (opts.items || []).slice(0, 4)

    // 所有图并发下载 + 解码，别一张一张串着等
    return Promise.all([
      toLocalPath(opts.avatar).then(p => loadImage(canvas, p)),
      toLocalPath(opts.qrFileID).then(p => loadImage(canvas, p)),
      Promise.all(cells.map(c => toLocalPath(c.image).then(p => loadImage(canvas, p))))
    ]).then(loaded => {
      const avatarImg = loaded[0]
      const qrImg = loaded[1]
      const cellImgs = loaded[2]

      // ---- 底 ----
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)

      // ---- 头部色块 ----
      ctx.fillStyle = MAROON
      ctx.fillRect(0, 0, W, 170)

      // 头像：先裁一个圆形区域，再把图画进去
      const ax = 40, ay = 45, ar = 40
      ctx.save()
      ctx.beginPath()
      ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2)
      ctx.clip()
      if (avatarImg) {
        drawCover(ctx, avatarImg, ax, ay, ar * 2, ar * 2)
      } else {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(ax, ay, ar * 2, ar * 2)
      }
      ctx.restore()

      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 30px sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(ellipsis(ctx, opts.nickname || '明大同学', 380), 145, 78)

      ctx.font = '20px sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.82)'
      ctx.fillText('在明尼助手上架的闲置', 145, 112)

      // ---- 商品四宫格 ----
      const M = 30, GAP = 20, CELL = (W - M * 2 - GAP) / 2   // 260
      const TOP = 205
      for (let i = 0; i < 4; i++) {
        const col = i % 2, row = Math.floor(i / 2)
        const x = M + col * (CELL + GAP)
        const y = TOP + row * (CELL + GAP)

        ctx.save()
        roundRect(ctx, x, y, CELL, CELL, 16)
        ctx.clip()
        const img = cellImgs[i]
        if (img) {
          drawCover(ctx, img, x, y, CELL, CELL)
        } else {
          ctx.fillStyle = '#f1efe8'
          ctx.fillRect(x, y, CELL, CELL)
        }
        // 价格压在图片左下角，先铺一层半透明黑，白字才看得清
        if (cells[i]) {
          ctx.fillStyle = 'rgba(0,0,0,0.55)'
          ctx.fillRect(x, y + CELL - 48, CELL, 48)
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 24px sans-serif'
          ctx.fillText(ellipsis(ctx, cells[i].price || '', CELL - 24), x + 14, y + CELL - 16)
        }
        ctx.restore()
      }

      // ---- 底部：小程序码 + 说明 ----
      const FY = TOP + CELL * 2 + GAP + 30      // 785
      if (qrImg) {
        ctx.drawImage(qrImg, M, FY - 20, 110, 110)
        ctx.fillStyle = '#2b2b2b'
        ctx.font = 'bold 24px sans-serif'
        ctx.fillText('长按识别，看看 TA 的闲置', M + 130, FY + 26)
        ctx.fillStyle = '#8a8a8a'
        ctx.font = '20px sans-serif'
        ctx.fillText('明尼助手 · 明大校园服务', M + 130, FY + 60)
      } else {
        // 小程序码拿不到（还没发布）时的降级：至少告诉别人去哪找
        ctx.fillStyle = '#2b2b2b'
        ctx.font = 'bold 26px sans-serif'
        ctx.fillText('微信搜索小程序「明尼助手」', M, FY + 30)
        ctx.fillStyle = '#8a8a8a'
        ctx.font = '20px sans-serif'
        ctx.fillText('明大校园闲置 · 转租 · 委托', M, FY + 64)
      }

      // ---- 导出成图片文件 ----
      return new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: canvas,
          success: res => resolve(res.tempFilePath),
          fail: reject
        })
      })
    })
  })
}

module.exports = { buildPoster: buildPoster, POSTER_W: W, POSTER_H: H }
