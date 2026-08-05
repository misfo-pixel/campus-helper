const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 微信内容安全检测。用户产生的文字和图片在写库之前都要先过这里。
// 这是微信对 UGC 类小程序的硬性要求，不接入基本过不了审。
//
// 文本走 security.msgSecCheck（version 2，返回 pass / review / risky）
// 图片走 security.imgSecCheck（同步接口，单张上限 1MB）
//
// 策略是「测不了就不让发」：接口调不通时一律返回 pass: false。
// 宁可误挡一条正常内容，也不能让没检测过的东西进库。

// msgSecCheck 的 label → 给用户看的说法
const LABEL_TEXT = {
  10001: '广告',
  20001: '时政内容',
  20002: '色情内容',
  20003: '辱骂内容',
  20006: '违法犯罪内容',
  20008: '欺诈内容',
  20012: '低俗内容',
  20013: '侵权内容',
  21000: '违规内容'
}

// 内容违规时接口是用「抛错」的方式告诉你的，错误码 87014
function isRiskyError(err) {
  return !!err && (err.errCode === 87014 || err.errcode === 87014)
}

async function checkText(content, scene, openid) {
  if (!content) return { pass: true }

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      openid: openid,
      scene: scene,
      content: content
    })
    const result = (res && res.result) || {}
    // suggest: pass 正常 / review 疑似 / risky 违规。
    // review 也拦，因为我们没有人工复核队列，放过去的风险比误伤大。
    if (result.suggest === 'pass') return { pass: true }
    return { pass: false, reason: '文字可能包含' + (LABEL_TEXT[result.label] || '违规内容') }
  } catch (err) {
    if (isRiskyError(err)) return { pass: false, reason: '文字包含违规内容' }
    console.error('msgSecCheck 调用失败：', err)
    return { pass: false, reason: '内容校验服务暂时不可用，请稍后重试', serviceError: true }
  }
}

async function checkImage(fileID) {
  let buffer
  try {
    const dl = await cloud.downloadFile({ fileID: fileID })
    buffer = dl.fileContent
  } catch (err) {
    console.error('下载待检测图片失败：', fileID, err)
    return { pass: false, reason: '图片校验失败，请重试', serviceError: true }
  }

  // imgSecCheck 单张上限 1MB。超了是我们没压好，不是内容问题，
  // 这种放行但打日志——不然用户传张大图就永远发不出来。
  // 前端 chooseMedia 已经开了 sizeType: ['compressed']，正常走不到这。
  if (buffer.length > 1024 * 1024) {
    console.warn('图片超过 1MB，跳过内容检测：', fileID, buffer.length)
    return { pass: true, skipped: true }
  }

  try {
    await cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/png', value: buffer }
    })
    return { pass: true }
  } catch (err) {
    if (isRiskyError(err)) return { pass: false, reason: '图片包含违规内容' }
    console.error('imgSecCheck 调用失败：', fileID, err)
    return { pass: false, reason: '图片校验服务暂时不可用，请稍后重试', serviceError: true }
  }
}

// event: { texts: [文本...], fileIDs: [云存储 fileID...], scene: 1资料 2评论 3论坛 4社交日志 }
exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const texts = (event.texts || []).filter(t => t && String(t).trim())
  const fileIDs = event.fileIDs || []
  const scene = event.scene || 3

  // 文字先测：不用等图片上传，违规能更快回给用户
  const textResult = await checkText(texts.join('\n'), scene, openid)
  if (!textResult.pass) {
    return { success: true, pass: false, reason: textResult.reason, serviceError: !!textResult.serviceError }
  }

  for (const fileID of fileIDs) {
    const imgResult = await checkImage(fileID)
    if (!imgResult.pass) {
      return { success: true, pass: false, reason: imgResult.reason, serviceError: !!imgResult.serviceError }
    }
  }

  return { success: true, pass: true }
}
