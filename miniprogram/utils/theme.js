// 海报和店铺页的个性化配色：店铺从 logo 取色，二手从头像和商品照片取色。
// 出来的结构，画图和页面只认这个：
//   { style: 'magazine' | 'chalkboard' | 'scrapbook',
//     palette: { bg, surface, ink, accent, accent2 }, bg: 头图 fileID 或 '' }
//
// 颜色好不好看交给照片，读不读得清交给这里：字和底色的对比度不够就强行换成黑或白。
//（2026-10-12 试过让 AI 出设计稿和背景图，额度没批下来，删了；bg 留着给以后的头图）

const STYLES = ['magazine', 'chalkboard', 'scrapbook']

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
}

// 两个颜色按比例混：mix(a, b, 0.2) = 80% 的 a + 20% 的 b
function mix(a, b, t) {
  const x = parseHex(a)
  const y = parseHex(b)
  return toHex(x.map((v, i) => v + (y[i] - v) * t))
}

// WCAG 相对亮度和对比度。正文要 4.5 以上才算读得清
function luminance(hex) {
  const c = parseHex(hex).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function contrast(a, b) {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// 在这个底色上最清楚的字色：近黑或近白
function readableOn(bg) {
  return contrast('#1d1418', bg) >= contrast('#fffdf8', bg) ? '#1d1418' : '#fffdf8'
}

function rgbToHsl(rgb) {
  const [r, g, b] = rgb.map(v => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255])
}

// 把一套配色修到读得清：ink 对 bg、ink 对 surface 都要 4.5，强调色对底色至少 2.2
function repair(p) {
  const out = Object.assign({}, p)
  if (contrast(out.ink, out.bg) < 4.5) out.ink = readableOn(out.bg)
  if (contrast(out.ink, out.surface) < 4.5) {
    out.surface = luminance(out.ink) < 0.4 ? mix(out.bg, '#ffffff', 0.85) : mix(out.bg, '#000000', 0.6)
    if (contrast(out.ink, out.surface) < 4.5) out.surface = readableOn(out.ink) === '#1d1418' ? '#1d1418' : '#fffdf8'
  }
  if (contrast(out.accent, out.bg) < 2.2) {
    const [h, s] = rgbToHsl(parseHex(out.accent))
    out.accent = hslToHex(h, Math.max(s, 0.6), luminance(out.bg) > 0.5 ? 0.38 : 0.62)
  }
  if (!parseHex(out.accent2)) out.accent2 = out.accent
  return out
}

// 从取到的几种颜色现算一套配色（logo、头像、商品照片）。
// 取最鲜艳的那个当强调色，底色用它很淡的一层，像这家店自己的纸
function fromColors(colors, style) {
  const list = (colors || []).map(parseHex).filter(Boolean)
  if (!list.length) return null
  const scored = list
    .map(rgb => ({ rgb: rgb, hsl: rgbToHsl(rgb) }))
    .filter(c => c.hsl[2] > 0.12 && c.hsl[2] < 0.9)
    .sort((a, b) => b.hsl[1] - a.hsl[1])
  const main = scored[0] || { hsl: rgbToHsl(list[0]) }
  const [h, s] = main.hsl
  const second = scored.find(c => Math.abs(c.hsl[0] - h) > 40)
  const accent = hslToHex(h, clamp(s, 0.45, 0.85), 0.42)
  // 第二种颜色：logo 里有色相差得够远的就用它，没有就用主色的深色版，别硬凑一个撞色
  const accent2 = second ? hslToHex(second.hsl[0], clamp(second.hsl[1], 0.45, 0.85), 0.45) : hslToHex(h, clamp(s * 0.8, 0.3, 0.7), 0.26)
  const dark = style === 'chalkboard'
  const bg = dark ? hslToHex(h, clamp(s * 0.35, 0.08, 0.3), 0.14) : hslToHex(h, clamp(s * 0.5, 0.15, 0.45), 0.94)
  return {
    style: style || 'magazine',
    mood: '',
    palette: repair({
      bg: bg,
      surface: dark ? hslToHex(h, 0.12, 0.2) : '#ffffff',
      ink: dark ? '#f6f1e7' : hslToHex(h, 0.35, 0.13),
      accent: dark ? hslToHex(h, clamp(s, 0.5, 0.9), 0.66) : accent,
      accent2: accent2
    }),
    bg: ''
  }
}

// 什么都没有时的兜底：暖米色 + 番茄红，中性、哪家店都不违和
const FALLBACK = {
  style: 'magazine',
  mood: '',
  palette: { bg: '#f7efe3', surface: '#ffffff', ink: '#2a1a14', accent: '#d2462c', accent2: '#e9a23b' },
  bg: ''
}

// 店铺页用的 CSS 变量，写在页面根节点的 style 上。
// 店铺页的卡片还是白底，所以强调色要在白底上读得清：黑板风格那种亮色强调色压暗一些再用
function cssVars(theme) {
  const p = (theme || FALLBACK).palette
  const accent = contrast(p.accent, '#ffffff') >= 3 ? p.accent : mix(p.accent, '#000000', 0.35)
  return [
    '--shop-accent:' + accent,
    '--shop-on-accent:' + readableOn(accent),
    '--shop-soft:' + mix('#ffffff', accent, 0.1),
    '--shop-line:' + mix('#ffffff', accent, 0.3)
  ].join(';')
}

module.exports = {
  STYLES: STYLES,
  FALLBACK: FALLBACK,
  parseHex: parseHex,
  toHex: toHex,
  mix: mix,
  contrast: contrast,
  readableOn: readableOn,
  repair: repair,
  fromColors: fromColors,
  cssVars: cssVars
}
