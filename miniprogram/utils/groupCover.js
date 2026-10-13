// 拼团和二手的两种图：转发卡片主图（5:4）和长图海报。
//
// 不用小程序自己的栗色和金色——每家店长得不一样：配色从这家店的 logo 取色
//（二手从头像和商品照片取色，见 utils/theme.js）。小程序只在最底下留一行小字和小程序码。
// 菜名、价格、日期都由代码画。
//
// 三种风格不是同一个模板换颜色，版式本身不一样：
//   magazine    杂志封面：大图头、一排排干净的卡片、细线和期号
//   chalkboard  菜单黑板：深色底、粉笔虚线框、手写感的价目列表
//   scrapbook   手账拼贴：纸张颗粒、歪着贴的拍立得、胶带、印章价签
//
// 长图把东西全部列出来：有照片的两列卡片，没照片的做成「菜名 ······ $12」一行字。
// 画布太高手机画不出来，所以超过 MAX_PHOTO_ITEMS 张照片后面的都改成一行字，
// 总数超过 MAX_ITEMS 就在最后写「还有 N 样」。

const { getCanvasNode, toLocalPath, loadImage, roundRect, ellipsis, drawCover } = require('./poster.js')
const { md, weekday, progress } = require('./group.js')
const { mix, readableOn, FALLBACK } = require('./theme.js')

const DISPLAY = '"HuangYou", sans-serif'
const display = size => size + 'px ' + DISPLAY
const body = (size, bold) => (bold ? 'bold ' : '') + size + 'px sans-serif'

const W = 600
const MAX_ITEMS = 80
const MAX_PHOTO_ITEMS = 36
const MAX_PIXELS_TALL = 12000   // 画布像素高度上限，iOS 上再高就画不出来了

// ---------- 小工具 ----------

function setup(canvas, w, h) {
  const ctx = canvas.getContext('2d')
  const want = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2
  const dpr = Math.max(1, Math.min(want, 2, MAX_PIXELS_TALL / h))
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.scale(dpr, dpr)
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  return ctx
}

function exportImage(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({ canvas: canvas, fileType: 'jpg', quality: 0.92, success: r => resolve(r.tempFilePath), fail: reject })
  })
}

function wrap(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(String(text || ''))
  const lines = []
  let line = ''
  chars.forEach(c => {
    if (ctx.measureText(line + c).width > maxWidth && line) {
      lines.push(line)
      line = c
    } else {
      line += c
    }
  })
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = ellipsis(ctx, kept[maxLines - 1] + lines.slice(maxLines).join(''), maxWidth)
    return kept
  }
  return lines
}

// 大标题：找一个能让每个分句完整占一行的字号；都不行就逐字折行
function fit(ctx, text, maxWidth, maxLines, big, small) {
  // 只在逗号、顿号处分句；空格不算（「在售 7 件」是一句）
  const parts = String(text || '').split(/[，,、]+/).map(p => p.trim()).filter(Boolean)
  if (parts.length > 1 && parts.length <= maxLines) {
    for (let size = big; size >= small; size -= 2) {
      ctx.font = display(size)
      if (parts.every(p => ctx.measureText(p).width <= maxWidth)) return { lines: parts, size: size }
    }
  }
  for (let size = big; size >= small; size -= 2) {
    ctx.font = display(size)
    const lines = wrap(ctx, text, maxWidth, 99)
    if (lines.length <= maxLines) return { lines: lines, size: size }
  }
  ctx.font = display(small)
  return { lines: wrap(ctx, text, maxWidth, maxLines), size: small }
}

function rgba(hex, a) {
  const n = parseInt(String(hex).slice(1), 16)
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
}

// 可重复的伪随机：同一张海报每次画出来一样（纸张颗粒、拍立得角度）
function seeded(seed) {
  let s = seed || 7
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function dashedRect(ctx, x, y, w, h, r, color, width, dash) {
  ctx.save()
  ctx.setLineDash(dash || [10, 8])
  roundRect(ctx, x, y, w, h, r)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.restore()
}

// 粉笔 / 手绘感的波浪下划线
function wavy(ctx, x, y, w, color, width) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  for (let i = 0; i < w; i += 12) ctx.quadraticCurveTo(x + i + 6, y + ((i / 12) % 2 ? 5 : -5), x + i + 12, y)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

function tape(ctx, cx, cy, w, angle, color) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  ctx.fillStyle = rgba(color, 0.55)
  ctx.fillRect(-w / 2, -11, w, 22)
  ctx.restore()
}

function paperGrain(ctx, w, h, color, rnd) {
  ctx.fillStyle = rgba(color, 0.05)
  for (let i = 0; i < (w * h) / 900; i++) ctx.fillRect(rnd() * w, rnd() * h, 2, 2)
}

function circleImage(ctx, img, cx, cy, r, ring, ringWidth) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.clip()
  if (img) drawCover(ctx, img, cx - r, cy - r, r * 2, r * 2)
  ctx.restore()
  if (ring) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.strokeStyle = ring
    ctx.lineWidth = ringWidth || 3
    ctx.stroke()
  }
}

function loadAll(canvas, list) {
  return Promise.all(list.map(id => toLocalPath(id).then(p => loadImage(canvas, p))))
}

function priceText(it) {
  return it.price !== '' && it.price !== undefined && it.price !== null ? '$' + it.price : ''
}

// ---------- 转发卡片（5:4） ----------

function badgeText(s) {
  const p = progress(s, true)
  if (p.open) return '下单就送'
  if (p.formed) return '已成团'
  return '还差' + p.gap + '位'
}

/**
 * d: { theme, shopName, slogan, logo, dishImage, date, count, min_orders }
 */
function renderCard(selector, component, d) {
  const CW = 500
  const CH = 400
  const theme = d.theme || FALLBACK
  const p = theme.palette
  const dark = theme.style === 'chalkboard'
  const tilt = theme.style === 'magazine' ? 0.04 : 0.09
  return getCanvasNode(selector, component).then(canvas => {
    const ctx = setup(canvas, CW, CH)
    return loadAll(canvas, [theme.bg, d.logo, d.dishImage]).then(([bg, logo, dish]) => {
      // 底：背景图从左往右压一层自家底色，左边的字才看得清；没有背景图就是纯底色 + 风格纹理
      ctx.fillStyle = p.bg
      ctx.fillRect(0, 0, CW, CH)
      if (bg) {
        drawCover(ctx, bg, 0, 0, CW, CH)
        const g = ctx.createLinearGradient(0, 0, CW, 0)
        g.addColorStop(0, rgba(p.bg, 0.94))
        g.addColorStop(0.55, rgba(p.bg, 0.6))
        g.addColorStop(1, rgba(p.bg, 0.05))
        ctx.fillStyle = g
        ctx.fillRect(0, 0, CW, CH)
      } else if (theme.style === 'scrapbook') {
        paperGrain(ctx, CW, CH, p.ink, seeded(3))
      }
      if (dark) dashedRect(ctx, 12, 12, CW - 24, CH - 24, 18, rgba(p.ink, 0.5), 2, [8, 7])

      circleImage(ctx, logo, 46, 48, 22, p.ink, 2)
      ctx.font = display(24)
      ctx.fillStyle = p.ink
      ctx.fillText(ellipsis(ctx, d.shopName, 230), 78, 57)

      // 菜：拍立得，手账风格加胶带
      if (dish) {
        ctx.save()
        ctx.translate(370, 178)
        ctx.rotate(tilt)
        ctx.shadowColor = 'rgba(0,0,0,0.25)'
        ctx.shadowBlur = 16
        ctx.shadowOffsetY = 6
        roundRect(ctx, -96, -104, 192, 216, theme.style === 'magazine' ? 14 : 4)
        ctx.fillStyle = dark ? '#f6f1e7' : '#ffffff'
        ctx.fill()
        ctx.restore()
        ctx.save()
        ctx.translate(370, 178)
        ctx.rotate(tilt)
        roundRect(ctx, -84, -92, 168, 168, theme.style === 'magazine' ? 10 : 2)
        ctx.clip()
        drawCover(ctx, dish, -84, -92, 168, 168)
        ctx.restore()
        if (theme.style === 'scrapbook') tape(ctx, 372, 76, 90, -0.12, p.accent2)
      }

      // 广告语：第一句用强调色
      const t = fit(ctx, d.slogan || d.shopName + ' 开团啦', dish ? 250 : 430, 3, 46, 30)
      const lh = Math.round(t.size * 1.22)
      const top = 268 - (t.lines.length - 1) * lh
      t.lines.forEach((l, i) => {
        ctx.font = display(t.size)
        ctx.fillStyle = i === 0 ? p.accent : p.ink
        ctx.fillText(l, 30, top + i * lh)
      })
      if (dark) wavy(ctx, 32, top + (t.lines.length - 1) * lh + 18, 150, p.accent2, 3)

      ctx.font = display(24)
      ctx.fillStyle = p.ink
      ctx.fillText(md(d.date) + ' ' + weekday(d.date) + ' 送到学校', 32, 354)

      // 进度：自家强调色的圆章
      ctx.save()
      ctx.translate(434, 332)
      ctx.rotate(-0.16)
      ctx.beginPath()
      ctx.arc(0, 0, 50, 0, Math.PI * 2)
      ctx.fillStyle = p.accent
      ctx.fill()
      const on = readableOn(p.accent)
      if (theme.style !== 'magazine') {
        ctx.setLineDash([5, 5])
        ctx.beginPath()
        ctx.arc(0, 0, 42, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(on, 0.6)
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.setLineDash([])
      }
      const main = badgeText(d)
      ctx.textAlign = 'center'
      ctx.fillStyle = on
      ctx.font = display(Array.from(main).length > 3 ? 24 : 28)
      ctx.fillText(main, 0, 10)
      ctx.textAlign = 'left'
      ctx.restore()

      return exportImage(canvas)
    })
  })
}

// ---------- 长图海报 ----------

/**
 * d: {
 *   theme, title, subtitle, logo, tag,
 *   when: { date, time } | null        拼团有，二手没有
 *   info: [string]                     取货点、门槛、截单
 *   sections: [{ title, items: [{ image, name, price }] }]
 *   qrFileID, footer
 * }
 */
function renderLong(selector, component, d) {
  const theme = d.theme || FALLBACK
  const style = theme.style
  const p = theme.palette
  const onSurface = readableOn(p.surface) === '#1d1418' ? '#2a1a14' : '#fffdf8'

  // 先排版、算好总高度——画布得先定尺寸才能画
  let total = 0
  const sections = (d.sections || []).map(sec => {
    const items = sec.items.slice(0, Math.max(0, MAX_ITEMS - total))
    total += items.length
    return { title: sec.title, items: items }
  }).filter(sec => sec.items.length)
  const allCount = (d.sections || []).reduce((n, s) => n + s.items.length, 0)
  let photoBudget = MAX_PHOTO_ITEMS
  sections.forEach(sec => {
    sec.photos = []
    sec.rows = []
    sec.items.forEach(it => {
      if (it.image && photoBudget > 0) {
        sec.photos.push(it)
        photoBudget--
      } else {
        sec.rows.push(it)
      }
    })
  })

  const M = 32
  const GAP = 18
  const CARD_W = (W - M * 2 - GAP) / 2
  const IMG_H = style === 'scrapbook' ? CARD_W - 24 : 196
  const CARD_H = style === 'scrapbook' ? IMG_H + 64 : IMG_H + 74
  const ROW_H = 54
  // 没有背景图（二手、AI 还没出图）时头图区收矮，不留一大块空
  const HERO_H = style === 'chalkboard' ? (theme.bg ? 600 : 400) : (theme.bg ? 560 : 380)
  const WHEN_H = d.when ? 150 : 0
  const QR = 132
  const INFO_W = W - M * 2 - QR - 22 - 48 - 24

  // 底部信息框的高度要看折成几行，得先量字——这时候画布还没定尺寸，先借它的 ctx 量
  function layout(measureCtx) {
    measureCtx.font = body(22, true)
    const infoLines = []
    ;(d.info || []).forEach(line => wrap(measureCtx, line, INFO_W, 2).forEach(l => infoLines.push(l)))
    const BOX_H = Math.max(QR + 48, 104 + infoLines.length * 32)
    let H = HERO_H + WHEN_H + 30
    sections.forEach(sec => {
      if (sec.title) H += 64
      H += Math.ceil(sec.photos.length / 2) * (CARD_H + GAP)
      H += sec.rows.length * ROW_H + (sec.rows.length ? 16 : 0)
    })
    if (allCount > total) H += 50
    H += 20 + BOX_H + 70
    return { H: H, BOX_H: BOX_H, infoLines: infoLines }
  }

  const photoIds = []
  sections.forEach(sec => sec.photos.forEach(it => photoIds.push(it.image)))

  return getCanvasNode(selector, component).then(canvas => {
    const { H, BOX_H, infoLines } = layout(canvas.getContext('2d'))
    const ctx = setup(canvas, W, H)
    const rnd = seeded(Array.from(d.title || '').length * 131 + 17)
    return loadAll(canvas, [theme.bg, d.logo, d.qrFileID].concat(photoIds)).then(imgs => {
      const [bg, logo, qr] = imgs
      const photoImgs = imgs.slice(3)
      let photoIndex = 0

      // ---- 底 ----
      ctx.fillStyle = p.bg
      ctx.fillRect(0, 0, W, H)
      if (style === 'scrapbook') paperGrain(ctx, W, H, p.ink, rnd)

      // ---- 头图 ----
      if (style === 'chalkboard') {
        // 黑板：头图嵌在粉笔虚线框里，店名和标题居中
        const artH = bg ? 250 : 0
        if (bg) {
          ctx.save()
          roundRect(ctx, M, M, W - M * 2, artH, 18)
          ctx.clip()
          drawCover(ctx, bg, M, M, W - M * 2, artH)
          ctx.restore()
        }
        dashedRect(ctx, M - 12, M - 12, W - M * 2 + 24, HERO_H - 24, 26, rgba(p.ink, 0.55), 2.5, [12, 9])
        const base = bg ? M + artH : 60
        circleImage(ctx, logo, W / 2, base + 40, 32, p.ink, 3)
        ctx.textAlign = 'center'
        ctx.font = display(26)
        ctx.fillStyle = rgba(p.ink, 0.85)
        ctx.fillText(ellipsis(ctx, d.title, 420), W / 2, base + 104)
        const t = fit(ctx, d.subtitle || d.title, W - M * 4, 2, 50, 32)
        const lh = Math.round(t.size * 1.2)
        t.lines.forEach((l, i) => {
          ctx.font = display(t.size)
          ctx.fillStyle = i === 0 ? p.accent : p.ink
          ctx.fillText(l, W / 2, base + 104 + 14 + (i + 1) * lh)
        })
        ctx.textAlign = 'left'
      } else {
        // 杂志 / 手账：头图铺满，往下渐变进自家底色，标题压在渐变上
        if (bg) {
          drawCover(ctx, bg, 0, 0, W, HERO_H)
          const g = ctx.createLinearGradient(0, HERO_H * 0.3, 0, HERO_H)
          g.addColorStop(0, rgba(p.bg, 0))
          g.addColorStop(0.7, rgba(p.bg, 0.85))
          g.addColorStop(1, rgba(p.bg, 1))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, HERO_H)
        }
        if (style === 'scrapbook' && bg) {
          // 撕纸边
          ctx.beginPath()
          ctx.moveTo(0, HERO_H - 36)
          for (let x = 0; x <= W; x += 18) ctx.lineTo(x, HERO_H - 36 + (rnd() * 14 - 4))
          ctx.lineTo(W, HERO_H)
          ctx.lineTo(0, HERO_H)
          ctx.closePath()
          ctx.fillStyle = p.bg
          ctx.fill()
        }
        // 左上：logo + 店名胶囊
        circleImage(ctx, logo, M + 26, M + 26, 26, p.ink, 2.5)
        ctx.font = display(26)
        const nameText = ellipsis(ctx, d.title, 300)
        const nameW = ctx.measureText(nameText).width
        roundRect(ctx, M + 62, M + 5, nameW + 32, 42, 21)
        ctx.fillStyle = rgba(p.surface, 0.92)
        ctx.fill()
        ctx.fillStyle = onSurface
        ctx.fillText(nameText, M + 78, M + 35)
        if (style === 'magazine' && d.when) {
          // 期号：右上角像杂志封面
          ctx.textAlign = 'right'
          ctx.font = display(22)
          ctx.fillStyle = bg ? '#ffffff' : p.ink
          ctx.fillText('NO.' + md(d.when.date).replace('/', '·'), W - M, M + 24)
          ctx.fillRect(W - M - 80, M + 34, 80, 2)
          ctx.textAlign = 'left'
        }
        if (d.tag && style === 'scrapbook') {
          ctx.save()
          ctx.translate(W - M - 52, M + 70)
          ctx.rotate(0.14)
          ctx.beginPath()
          ctx.arc(0, 0, 46, 0, Math.PI * 2)
          ctx.fillStyle = rgba(p.surface, 0.9)
          ctx.fill()
          ctx.strokeStyle = p.accent2
          ctx.lineWidth = 3
          ctx.stroke()
          ctx.textAlign = 'center'
          ctx.font = display(24)
          ctx.fillStyle = p.accent2
          ctx.fillText(d.tag, 0, 9)
          ctx.textAlign = 'left'
          ctx.restore()
        }
        const t = fit(ctx, d.subtitle || d.title, W - M * 2, 3, 76, 44)
        const lh = Math.round(t.size * 1.18)
        const yEnd = HERO_H - 40
        t.lines.forEach((l, i) => {
          const y = yEnd - (t.lines.length - 1 - i) * lh
          ctx.font = display(t.size)
          if (style === 'scrapbook' && i === 0) {
            // 第一行贴在一条斜着的彩色胶带上
            const w = ctx.measureText(l).width
            ctx.save()
            ctx.translate(M - 8, y - t.size * 0.86)
            ctx.rotate(-0.025)
            ctx.fillStyle = p.accent
            ctx.fillRect(0, 0, w + 26, t.size * 1.08)
            ctx.restore()
            ctx.fillStyle = readableOn(p.accent)
            ctx.fillText(l, M + 5, y)
          } else {
            ctx.fillStyle = i === 0 && style === 'magazine' ? p.accent : p.ink
            ctx.fillText(l, M, y)
          }
        })
      }

      let y = HERO_H

      // ---- 哪天、几点 ----
      if (d.when) {
        const day = String(Number(String(d.when.date).slice(8)))
        ctx.font = display(100)
        ctx.fillStyle = p.accent
        ctx.fillText(day, M, y + 104)
        const dw = ctx.measureText(day).width
        ctx.font = display(32)
        ctx.fillStyle = p.ink
        ctx.fillText(weekday(d.when.date) + ' ' + d.when.time, M + dw + 20, y + 62)
        ctx.font = body(22, true)
        ctx.fillStyle = rgba(p.ink, 0.7)
        ctx.fillText(md(d.when.date) + ' 送到学校', M + dw + 22, y + 100)
        if (style === 'chalkboard') wavy(ctx, M, y + WHEN_H - 18, W - M * 2, rgba(p.ink, 0.35), 2)
        else {
          ctx.fillStyle = rgba(p.ink, 0.14)
          ctx.fillRect(M, y + WHEN_H - 16, W - M * 2, 2)
        }
        y += WHEN_H
      }
      y += 30

      // ---- 全部商品 ----
      sections.forEach(sec => {
        if (sec.title) {
          ctx.font = display(32)
          ctx.fillStyle = p.ink
          ctx.fillText(sec.title, M, y + 34)
          const tw = ctx.measureText(sec.title).width
          if (style === 'chalkboard') wavy(ctx, M, y + 48, tw + 10, p.accent, 3)
          else {
            ctx.fillStyle = p.accent
            ctx.fillRect(M, y + 44, Math.min(tw, 60), 5)
          }
          y += 64
        }

        sec.photos.forEach((it, i) => {
          const x = M + (i % 2) * (CARD_W + GAP)
          const cy = y + Math.floor(i / 2) * (CARD_H + GAP)
          const img = photoImgs[photoIndex++]
          const price = priceText(it)

          if (style === 'scrapbook') {
            // 拍立得：白框、歪一点、角上胶带、价签印章
            const angle = (rnd() - 0.5) * 0.07
            ctx.save()
            ctx.translate(x + CARD_W / 2, cy + CARD_H / 2)
            ctx.rotate(angle)
            ctx.translate(-CARD_W / 2, -CARD_H / 2)
            ctx.shadowColor = 'rgba(0,0,0,0.18)'
            ctx.shadowBlur = 10
            ctx.shadowOffsetY = 4
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, CARD_W, CARD_H)
            ctx.shadowColor = 'transparent'
            if (img) drawCover(ctx, img, 12, 12, CARD_W - 24, IMG_H)
            ctx.font = body(22, true)
            ctx.fillStyle = '#2a1a14'
            ctx.fillText(ellipsis(ctx, it.name, CARD_W - 28), 14, IMG_H + 44)
            ctx.restore()
            tape(ctx, x + CARD_W / 2, cy + 4, 70, (rnd() - 0.5) * 0.4, p.accent2)
            if (price) {
              ctx.save()
              ctx.translate(x + CARD_W - 36, cy + IMG_H - 8)
              ctx.rotate(-0.2)
              ctx.beginPath()
              ctx.arc(0, 0, 32, 0, Math.PI * 2)
              ctx.fillStyle = p.accent
              ctx.fill()
              ctx.textAlign = 'center'
              ctx.fillStyle = readableOn(p.accent)
              ctx.font = display(price.length > 4 ? 18 : 23)
              ctx.fillText(price, 0, 8)
              ctx.textAlign = 'left'
              ctx.restore()
            }
            return
          }

          // 杂志 / 黑板：卡片，图在上，名字和价格在下
          const radius = style === 'magazine' ? 18 : 10
          ctx.save()
          if (style === 'magazine') {
            ctx.shadowColor = rgba(p.ink, 0.12)
            ctx.shadowBlur = 18
            ctx.shadowOffsetY = 6
          }
          roundRect(ctx, x, cy, CARD_W, CARD_H, radius)
          ctx.fillStyle = p.surface
          ctx.fill()
          ctx.restore()
          if (style === 'chalkboard') dashedRect(ctx, x, cy, CARD_W, CARD_H, radius, rgba(p.ink, 0.35), 1.5, [6, 6])
          ctx.save()
          roundRect(ctx, x + 6, cy + 6, CARD_W - 12, IMG_H, radius - 4)
          ctx.clip()
          if (img) drawCover(ctx, img, x + 6, cy + 6, CARD_W - 12, IMG_H)
          else {
            ctx.fillStyle = mix(p.surface, p.accent, 0.12)
            ctx.fillRect(x + 6, cy + 6, CARD_W - 12, IMG_H)
          }
          ctx.restore()
          ctx.font = display(28)
          const pw = price ? ctx.measureText(price).width : 0
          ctx.fillStyle = p.accent
          if (price) ctx.fillText(price, x + CARD_W - pw - 16, cy + IMG_H + 48)
          ctx.font = body(22, true)
          ctx.fillStyle = onSurface
          ctx.fillText(ellipsis(ctx, it.name, CARD_W - pw - 40), x + 16, cy + IMG_H + 46)
        })
        y += Math.ceil(sec.photos.length / 2) * (CARD_H + GAP)

        // 没照片的：菜单板一行字，名字和价格之间点点连起来
        sec.rows.forEach(it => {
          const price = priceText(it)
          ctx.font = display(28)
          const pw = ctx.measureText(price).width
          ctx.fillStyle = p.accent
          ctx.fillText(price, W - M - pw, y + 36)
          ctx.font = body(24, true)
          ctx.fillStyle = p.ink
          const name = ellipsis(ctx, it.name, W - M * 2 - pw - 80)
          ctx.fillText(name, M, y + 36)
          const nw = ctx.measureText(name).width
          ctx.fillStyle = rgba(p.ink, 0.3)
          for (let dx = M + nw + 14; dx < W - M - pw - 12; dx += 10) {
            ctx.beginPath()
            ctx.arc(dx, y + 30, 1.6, 0, Math.PI * 2)
            ctx.fill()
          }
          y += ROW_H
        })
        if (sec.rows.length) y += 16
      })

      if (allCount > total) {
        ctx.font = body(22, true)
        ctx.fillStyle = rgba(p.ink, 0.6)
        ctx.textAlign = 'center'
        ctx.fillText('还有 ' + (allCount - total) + ' 样，扫码看全部', W / 2, y + 30)
        ctx.textAlign = 'left'
        y += 50
      }

      // ---- 底：取货 / 门槛 / 截单 + 小程序码 ----
      y += 20
      roundRect(ctx, M, y, W - M * 2, BOX_H, style === 'magazine' ? 20 : 12)
      ctx.fillStyle = style === 'chalkboard' ? rgba(p.ink, 0.07) : p.surface
      ctx.fill()
      if (style !== 'magazine') dashedRect(ctx, M, y, W - M * 2, BOX_H, 12, rgba(p.ink, 0.4), 2, [8, 6])
      const qx = W - M - QR - 22
      const qy = y + (BOX_H - QR) / 2
      if (qr) {
        ctx.drawImage(qr, qx, qy, QR, QR)
      } else {
        ctx.beginPath()
        ctx.arc(qx + QR / 2, qy + QR / 2, QR / 2, 0, Math.PI * 2)
        ctx.fillStyle = mix(p.surface, p.accent, 0.15)
        ctx.fill()
        ctx.textAlign = 'center'
        ctx.font = display(22)
        ctx.fillStyle = p.accent
        ctx.fillText('搜明尼助手', qx + QR / 2, qy + QR / 2 + 8)
        ctx.textAlign = 'left'
      }
      ctx.font = display(32)
      ctx.fillStyle = p.accent
      ctx.fillText(qr ? '长按识别' : '微信搜索', M + 24, y + 56)
      ctx.font = body(22, true)
      ctx.fillStyle = style === 'chalkboard' ? p.ink : onSurface
      infoLines.forEach((line, i) => ctx.fillText(line, M + 24, y + 98 + i * 32))

      ctx.font = body(18)
      ctx.fillStyle = rgba(p.ink, 0.5)
      ctx.textAlign = 'center'
      ctx.fillText(d.footer || '明尼助手', W / 2, H - 26)
      ctx.textAlign = 'left'

      return exportImage(canvas)
    })
  })
}

// 海报出图后打开图片预览，长按就能保存、发给朋友。
// 不用 wx.showShareImageMenu：它的「保存」要求小程序在后台「用户隐私保护指引」里
// 声明「相册（仅写入）」，没声明就提示「暂无图片保存权限」。预览里的长按菜单是微信自己的，不受这个限制
function showPoster(path) {
  wx.previewImage({ urls: [path], current: path, showmenu: true })
}

module.exports = {
  renderCard: renderCard,
  renderLong: renderLong,
  showPoster: showPoster
}
