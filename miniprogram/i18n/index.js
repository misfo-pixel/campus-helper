// 中英文切换。2026-10-13 加的。
//
// 做法是 gettext 那一路：中文原文本身就是 key，英文写在 en.js 里。
//   - 页面代码里照旧写中文，只是包一层 t('保存')；没翻译到的词自动回落成中文，不会出现空白
//   - WXML 里用 i18n.wxs（由 scripts/i18n.js 从 en.js 生成，别手改），写法是 {{i18n.t('保存', lang)}}
//   - 带变量的句子用占位符：f('还差 {0} 位', n)，英文那边自己决定 {0} 放哪
//
// lang 存在本地（LANG_KEY），默认跟随微信的语言设置。切换语言后整个小程序重启
// （见 setLang），所有页面按新语言重新注册，不用逐页刷新。
//
// 云函数返回的提示（res.result.message）也是中文原文，前端 toast 时过一遍 t() 就能翻译，
// 云函数不用改。订阅消息的模板文字是微信后台审批过的，只有中文，翻不了。

const EN = require('./en.js')

const LANG_KEY = 'lang'
let current = null

function detect() {
  try {
    const saved = wx.getStorageSync(LANG_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch (e) { /* 读不到就按微信语言 */ }
  try {
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    return /^en/i.test(info.language || '') ? 'en' : 'zh'
  } catch (e) {
    return 'zh'
  }
}

function getLang() {
  if (!current) current = detect()
  return current
}

function t(text) {
  if (typeof text !== 'string' || getLang() !== 'en') return text
  return Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] : text
}

// f('还差 {0} 位，{1} 截单', 3, '周四') —— 先翻译模板，再填参数
function f(template) {
  let out = t(template)
  for (let i = 1; i < arguments.length; i++) {
    out = out.split('{' + (i - 1) + '}').join(arguments[i] === undefined || arguments[i] === null ? '' : String(arguments[i]))
  }
  return out
}

function setLang(lang) {
  if (lang !== 'zh' && lang !== 'en') return
  try { wx.setStorageSync(LANG_KEY, lang) } catch (e) { /* 存不上就只对这次生效 */ }
  current = lang
  // 重启后 app.js 和所有页面按新语言重新注册；老基础库没有这个接口，退回到 reLaunch
  if (wx.restartMiniProgram) {
    wx.restartMiniProgram({ path: '/pages/profile/profile' })
  } else {
    wx.reLaunch({ url: '/pages/profile/profile' })
  }
}

module.exports = { getLang: getLang, setLang: setLang, t: t, f: f }
