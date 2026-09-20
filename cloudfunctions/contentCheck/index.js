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

// 把错误码拼进给用户看的提示里。控制台日志不一定查得到，
// 用户截个图就能知道是哪一步、什么原因坏的。
// 顺带也能分清两类「不可用」：带错误码的是云函数里报的，
// 不带的是小程序端 callFunction 本身就失败了（utils/contentCheck.js）。
function codeSuffix(err) {
  const code = err && (err.errCode || err.errcode)
  return code ? '（错误码 ' + code + '）' : '（错误码未知）'
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
    console.error('msgSecCheck 调用失败：errCode=', err && (err.errCode || err.errcode),
                  'errMsg=', err && (err.errMsg || err.errmsg), err)
    return { pass: false, reason: '内容校验服务暂时不可用' + codeSuffix(err) + '，请稍后重试', serviceError: true }
  }
}

async function checkImage(fileID) {
  let buffer
  try {
    const dl = await cloud.downloadFile({ fileID: fileID })
    buffer = dl.fileContent
  } catch (err) {
    console.error('下载待检测图片失败：', fileID, err)
    return { pass: false, reason: '图片校验失败' + codeSuffix(err) + '，请重试', serviceError: true }
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
    console.error('imgSecCheck 调用失败：', fileID, 'errCode=', err && (err.errCode || err.errcode),
                  'errMsg=', err && (err.errMsg || err.errmsg), err)
    return { pass: false, reason: '图片校验服务暂时不可用' + codeSuffix(err) + '，请稍后重试', serviceError: true }
  }
}

// 文字 + 图片一起检测，返回 { pass, reason, serviceError }
async function checkAll(texts, fileIDs, scene, openid) {
  // 文字先测：违规能更快回给用户
  const textResult = await checkText(texts.join('\n'), scene, openid)
  if (!textResult.pass) return textResult

  // 图片同时测，不要一张张排队：每张要下载 + 调一次接口，
  // 串行时 3 张就会超过云函数默认的 3 秒超时，前端只能看到「不可用」
  const imgResults = await Promise.all(fileIDs.map(checkImage))
  return imgResults.find(r => !r.pass) || { pass: true }
}

// ── 审核模式：先发后审 ──
//
// 发布页不再等审核：前端传完图就把帖子以 reviewing 状态写进库，马上告诉用户「已提交」，
// 然后发一个 review 请求过来、不等结果。列表页只查 on_sale / open，
// 所以审核中的帖子别人看不到——「没审过不公开」这条线没有放松，只是用户不用干等。
//
// 为什么不另开一个云函数：msgSecCheck 要发帖人的 openid，只有小程序端直接调的云函数
// 才拿得到（云函数互调时 OPENID 是空的）。
const db = cloud.database()

const REVIEW_TYPES = {
  item: {
    collection: 'secondhand_items',
    live: 'on_sale',
    texts: d => [d.title, d.description, d.seller_wechat]
  },
  sublet: {
    collection: 'sublet_items',
    live: 'on_sale',
    texts: d => [d.title, d.address, d.roommate_info, d.description, d.contact_wechat]
  },
  task: {
    collection: 'task_items',
    live: 'open',       // 任务在列表里用的是 open
    texts: d => [d.title, d.description, d.location, d.contact_wechat]
  }
}

async function review(type, id, openid) {
  const cfg = REVIEW_TYPES[type]
  if (!cfg || !id) return { success: false, message: '参数不对' }

  let doc
  try {
    doc = (await db.collection(cfg.collection).doc(id).get()).data
  } catch (err) {
    return { success: false, message: '帖子不存在' }
  }
  // 只能送审自己的帖子
  if (!doc || doc._openid !== openid) return { success: false, message: '无权操作' }
  // 已经审过了（重复送审、自动补审撞上正常审核），直接报当前状态。幂等的关键之一
  if (doc.status !== 'reviewing') return { success: true, status: doc.status, reason: doc.reject_reason || '' }

  const texts = cfg.texts(doc).filter(t => t && String(t).trim())
  const result = await checkAll(texts, doc.images || [], 3, openid)

  // 审核服务本身挂了：不能放行，也不能判违规——留在 reviewing，下次打开「我的发布」会自动再送审
  if (!result.pass && result.serviceError) {
    return { success: true, status: 'reviewing', retry: true, reason: result.reason }
  }

  const patch = result.pass
    ? { status: cfg.live, reviewed_at: new Date() }
    : { status: 'rejected', reject_reason: result.reason, images: [], thumb: '', reviewed_at: new Date() }

  // 条件更新：只有还是 reviewing 才改。两个请求同时审完，第二个在这里改 0 条，
  // 不会出现「一个判通过、一个判违规，后到的覆盖先到的」
  const upd = await db.collection(cfg.collection)
    .where({ _id: id, status: 'reviewing' })
    .update({ data: patch })

  // 违规图片不在云存储里留着，文字留下给发布者看是哪条被拦了
  if (!result.pass && upd.stats.updated > 0) {
    const files = (doc.images || []).concat(doc.thumb ? [doc.thumb] : [])
    if (files.length) await cloud.deleteFile({ fileList: files }).catch(err => console.error('清理违规图片失败：', err))
  }

  return { success: true, status: patch.status, reason: result.pass ? '' : result.reason }
}

// 两种用法：
//   检测：{ texts: [文本...], fileIDs: [云存储 fileID...], scene: 1资料 2评论 3论坛 4社交日志 }
//   审核：{ review: { type: 'item' | 'sublet' | 'task', id } }，见上面的 review()
exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID

  if (event.review) return review(event.review.type, event.review.id, openid)

  const texts = (event.texts || []).filter(t => t && String(t).trim())
  const fileIDs = event.fileIDs || []
  const scene = event.scene || 3

  const r = await checkAll(texts, fileIDs, scene, openid)
  if (!r.pass) return { success: true, pass: false, reason: r.reason, serviceError: !!r.serviceError }
  return { success: true, pass: true }
}
