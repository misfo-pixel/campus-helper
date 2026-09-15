// 生成「扫码直达某个用户主页」的小程序码，给海报用。
//
// ⚠️ wxacode.getUnlimited 要求小程序**已经发布过正式版本**。开发阶段调用会报
// 41030（page 不存在），这是正常的——前端做了降级，拿不到码就画一行文字提示。
//
// 生成一次要几百毫秒，所以把结果存进云存储，同一个 uid 第二次直接复用。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const PAGE = 'pages/userstore/userstore'

exports.main = async (event) => {
  const uid = event.uid
  if (!uid) return { success: false, message: '缺少 uid' }

  // scene 最长 32 个字符，users 文档的 _id 正好 32 位，卡在边界上
  if (uid.length > 32) return { success: false, message: 'scene 超长' }

  const cloudPath = 'minicode/' + uid + '.png'

  try {
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: uid,
      page: PAGE,
      width: 280,
      checkPath: true,
      envVersion: 'release'
    })

    const up = await cloud.uploadFile({
      cloudPath: cloudPath,
      fileContent: res.buffer
    })
    return { success: true, fileID: up.fileID }
  } catch (err) {
    // 小程序还没发布、page 不存在、接口额度用完——都走这里。
    // 不抛异常：海报没有码也应该能生成，只是少一个扫码入口。
    console.error('生成小程序码失败：', err)
    return { success: false, message: String(err && err.errCode || err) }
  }
}
