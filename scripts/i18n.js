// 中英文切换的维护脚本（见 miniprogram/i18n/index.js）。改了 en.js 或加了页面之后跑一次：
//
//   node scripts/i18n.js            生成 i18n.wxs、titles.js，并列出还没翻译的中文
//   node scripts/i18n.js --missing  只把没翻译的中文按 JSON 打出来，方便补进 en.js
//
// 生成的两个文件别手改：
//   i18n/i18n.wxs   WXML 里用的那份词典。WXS 不能 require .js，只能把 en.js 抄一份过去
//   i18n/titles.js  各页面 json 里的导航栏标题（页面路径 → 中文），app.js 英文时拿它换标题
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const I18N = path.join(ROOT, 'i18n')
const EN = require(path.join(I18N, 'en.js'))

function walk(dir, exts, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'i18n') walk(full, exts, out)
    } else if (exts.includes(path.extname(name))) {
      out.push(full)
    }
  }
  return out
}

// ---- titles.js ----
const titles = {}
for (const file of walk(path.join(ROOT, 'pages'), ['.json'], [])) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (json.navigationBarTitleText) {
    titles[path.relative(ROOT, file).replace(/\\/g, '/').replace(/\.json$/, '')] = json.navigationBarTitleText
  }
}
fs.writeFileSync(path.join(I18N, 'titles.js'),
  '// 由 scripts/i18n.js 生成，别手改\nmodule.exports = ' + JSON.stringify(titles, null, 2) + '\n')

// ---- i18n.wxs ----
fs.writeFileSync(path.join(I18N, 'i18n.wxs'), `// 由 scripts/i18n.js 从 en.js 生成，别手改
var en = ${JSON.stringify(EN, null, 1)};

function t(s, lang) {
  if (lang !== 'en' || typeof s !== 'string') return s;
  var v = en[s];
  return v === undefined ? s : v;
}

function f(s, lang, a0, a1, a2, a3, a4) {
  var out = t(s, lang);
  var args = [a0, a1, a2, a3, a4];
  for (var i = 0; i < args.length; i++) {
    out = out.split('{' + i + '}').join(args[i] === undefined || args[i] === null ? '' : '' + args[i]);
  }
  return out;
}

module.exports = { t: t, f: f };
`)

// ---- 还没翻译的 ----
// 收集范围：
//   1. WXML 里 i18n.t / i18n.f 的第一个参数
//   2. 小程序 JS 里所有中文字符串字面量（注释、console 那一行除外）。有些是存库的值、
//      比较用的 key，用不到翻译，但多一条无害，漏一条就是界面上冒出中文
//   3. 云函数里 message: / reason: 后面的中文（前端 toast 时会过 t()）
//   4. 页面标题，以及 EXTRA 里那几条拼出来的 key（代码里看不到完整字面量）
const EXTRA = [
  '{0} 条闲置', '{0} 条转租', '{0} 个任务', '{0} 个群组',
  '{0} 在明尼助手的闲置', '{0} 在明尼助手的转租', '{0} 在明尼助手的任务', '{0} 在明尼助手的群组'
]
const HAN = /[一-鿿]/

// 去掉注释，字符串原样保留
function stripComments(src) {
  let out = ''
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/' && src[i - 1] !== ':') {
      const j = src.indexOf('\n', i); i = j === -1 ? src.length : j
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 2
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1); i = j + 1
    } else {
      out += c; i++
    }
  }
  return out
}

function unescape(s) {
  return s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c))
}

const used = new Set(Object.values(titles).concat(EXTRA))
for (const file of walk(ROOT, ['.wxml'], [])) {
  const src = fs.readFileSync(file, 'utf8')
  const re = /i18n\.[tf]\(\s*'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(src))) if (HAN.test(m[1])) used.add(unescape(m[1]))
}
for (const file of walk(ROOT, ['.js'], [])) {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  for (const line of lines) {
    if (/console\.(log|warn|error|info)|new Error\(/.test(line)) continue
    const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g
    let m
    while ((m = re.exec(line))) {
      const v = m[1] !== undefined ? m[1] : m[2]
      if (HAN.test(v)) used.add(unescape(v))
    }
  }
}
const CF = path.join(__dirname, '..', 'cloudfunctions')
for (const file of walk(CF, ['.js'], [])) {
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  const re = /\b(?:message|reason)\s*:\s*'((?:[^'\\\n]|\\.)*)'/g
  let m
  while ((m = re.exec(src))) if (HAN.test(m[1])) used.add(unescape(m[1]))
}

const missing = [...used].filter(k => !Object.prototype.hasOwnProperty.call(EN, k))
if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 1))
} else {
  console.log(`词条 ${Object.keys(EN).length} 条，代码里用到 ${used.size} 条，还没翻译 ${missing.length} 条`)
}
