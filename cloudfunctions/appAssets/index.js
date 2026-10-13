const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 小程序要用、但不想塞进主包的静态资源。现在只有一个：拼团海报的标题字体。
//
// 字体是站酷庆科黄油体（ZCOOL QingKe HuangYou，SIL OFL 1.1，可免费商用，许可证见 OFL-huangyou.txt），
// 只留了 GB2312 一级常用字 3755 个 + ASCII + 中文标点，转成 WOFF，约 800KB。
// 主包只有 2MB，放不下，所以随这个云函数一起部署：第一次有人要时传进云存储，
// 文件 ID 记在 app_assets 集合里，之后直接给临时下载链接。
// 小程序端用 wx.loadFontFace 加载（utils/fonts.js），每次启动一次，下载后系统会缓存。
//
// 换字体文件时把 VERSION 加一，就会传一份新的，老链接不受影响。

const ASSETS = {
  huangyou: { file: 'huangyou.woff', version: 1 }
}

const URL_MAX_AGE = 7 * 24 * 3600   // 临时链接 7 天

let ready = false
async function ensureCollection() {
  if (ready) return
  try {
    await db.createCollection('app_assets')
  } catch (e) { /* 已经存在 */ }
  ready = true
}

exports.main = async (event) => {
  const asset = ASSETS[event.name]
  if (!asset) return { success: false, message: '没有这个资源' }

  try {
    await ensureCollection()
    const key = event.name + '_v' + asset.version
    let fileID = ''
    try {
      fileID = (await db.collection('app_assets').doc(key).get()).data.fileID
    } catch (e) {
      fileID = ''
    }

    if (!fileID) {
      const up = await cloud.uploadFile({
        cloudPath: 'assets/' + key + path.extname(asset.file),
        fileContent: fs.readFileSync(path.join(__dirname, asset.file))
      })
      fileID = up.fileID
      // 两个实例同时第一次上传也没关系：同一个 cloudPath 覆盖，set 也是覆盖
      await db.collection('app_assets').doc(key).set({ data: { fileID: fileID, updated_at: new Date() } })
    }

    const res = await cloud.getTempFileURL({ fileList: [{ fileID: fileID, maxAge: URL_MAX_AGE }] })
    const url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
    if (!url) return { success: false, message: '拿不到下载链接' }
    return { success: true, url: url, expires_in: URL_MAX_AGE }
  } catch (err) {
    console.error('appAssets 失败：', event.name, err)
    return { success: false, message: '资源暂时不可用' }
  }
}
