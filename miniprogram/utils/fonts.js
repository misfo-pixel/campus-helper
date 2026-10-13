// 展示字体：站酷庆科黄油体（和宣传海报同一款）。拼团的转发卡片、海报标题，
// 还有列表日期、参团成功大字这几处展示文字用它，正文仍是系统字体。
//
// 字体文件在云函数 appAssets 里（主包放不下），这里拿下载链接、wx.loadFontFace 全局加载。
// 链接存本地，7 天内不用再问云函数；字体文件本身系统会缓存。
// 加载失败不报错，只是退回系统黑体——字体是锦上添花，不能卡住转发和出图。

const FAMILY = 'HuangYou'
const URL_KEY = 'fontUrl.huangyou'

let loading = null

function cachedUrl() {
  try {
    const c = wx.getStorageSync(URL_KEY)
    return c && c.url && c.expires > Date.now() ? c.url : ''
  } catch (e) {
    return ''
  }
}

function fetchUrl() {
  const hit = cachedUrl()
  if (hit) return Promise.resolve(hit)
  return wx.cloud.callFunction({ name: 'appAssets', data: { name: 'huangyou' } }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) return ''
    try {
      // 提前一天当过期，别拿着快过期的链接去下载
      wx.setStorageSync(URL_KEY, { url: r.url, expires: Date.now() + (r.expires_in - 86400) * 1000 })
    } catch (e) {}
    return r.url
  })
}

// 返回 Promise<boolean>：true = 加载好了。同一次启动只加载一次
function loadDisplayFont() {
  if (loading) return loading
  loading = fetchUrl().then(url => new Promise(resolve => {
    if (!url || !wx.loadFontFace) return resolve(false)
    wx.loadFontFace({
      global: true,
      family: FAMILY,
      source: 'url("' + url + '")',
      // native：canvas 2d 也能用；webview：WXML 里的展示文字也能用
      scopes: ['webview', 'native'],
      success: () => resolve(true),
      fail: err => {
        console.warn('展示字体加载失败，用系统字体：', err)
        resolve(false)
      }
    })
  })).catch(() => false)
  // 失败了允许下次再试
  loading.then(ok => { if (!ok) loading = null })
  return loading
}

// 最多等 ms 毫秒：转发时微信只等 3 秒，字体没下完就先用系统字体画
function withFont(ms) {
  return Promise.race([loadDisplayFont(), new Promise(r => setTimeout(() => r(false), ms))])
}

module.exports = {
  FAMILY: FAMILY,
  loadDisplayFont: loadDisplayFont,
  withFont: withFont
}
