// 学校邮箱验证。下单、发布前必须验证过一个教育邮箱（xx.edu，以及 xx.edu.cn 这类国家后缀，
// 子域也算），只认这一种：社会人员不能下单和发布，开店走开店码不受影响。
// 验证过的 users 上标 email_verified + is_student，资料页显示「学生」。
//
// 邮箱本身不放 users：users 前端能直接查（见 utils/user.js 的兜底查询），放进去
// 等于公开。单独存 user_emails（_id = openid），只有云函数读得到；users 上只留
// email_verified / is_student 两个布尔量。
//
// 发信走腾讯云邮件推送（SES，中国香港地域）的模板 API，不走 SMTP：SMTP 发的是没审核过的内容，
// 会被分到共享的兜底 IP，进垃圾箱的多。发信域名 mail.minnepal.com 的 MX / SPF / DKIM / DMARC
// 记录在 Vercel DNS 里，删了就发不出去。
// 密钥放云函数环境变量（控制台 → 云函数 → emailVerify → 版本与配置）：
//   SES_SECRET_ID  SES_SECRET_KEY —— 访问管理里只给邮件推送权限的子用户的 API 密钥
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const ses = require('tencentcloud-sdk-nodejs-ses')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STUDENT_RE = /@(?:[a-z0-9-]+\.)+edu(?:\.[a-z]{2})?$/i
// 提审开关：微信审核员没有 .edu 邮箱，过不了验证就体验不到下单和发布，会被以「功能无法体验」打回。
// 提审前在云函数环境变量里加 ALLOW_ANY_EMAIL=1：任何邮箱都能验证通过，只是不标「学生」；审核通过后删掉这个变量。
// 开着期间用普通邮箱验证过的账号会一直保持已验证，这是有意的——审核员复审时不用再验一遍
const ALLOW_ANY_EMAIL = process.env.ALLOW_ANY_EMAIL === '1'
const CODE_TTL_MS = 10 * 60 * 1000
const RESEND_GAP_MS = 60 * 1000
const DAILY_LIMIT = 10
const MAX_ATTEMPTS = 5

const SES_REGION = 'ap-hongkong'
const SES_FROM = '明尼助手 <no-reply@mail.minnepal.com>'
// 控制台「发信模板」里的「邮箱验证码」，正文变量 {{code}}；改模板要重新审核，ID 不变
const SES_TEMPLATE_ID = 224892

// 两个集合都是新的，第一次用时自动建；建好后控制台把权限改成「所有用户不可读写」
let collectionsReady = false
async function ensureCollections() {
  if (collectionsReady) return
  for (const name of ['email_codes', 'user_emails']) {
    try {
      await db.createCollection(name)
    } catch (e) { /* 已经存在 */ }
  }
  collectionsReady = true
}

function hashCode(openid, code) {
  return crypto.createHash('sha256').update(openid + ':' + code).digest('hex')
}

function getDoc(name, id) {
  return db.collection(name).doc(id).get().then(r => r.data, () => null)
}

// 同一个邮箱只能挂一个微信号，不然一个 .edu 邮箱能让一群社会人员都绕过门槛
async function takenByOther(email, openid) {
  const res = await db.collection('user_emails').where({ email: email }).limit(5).get()
  return res.data.some(d => d._id !== openid)
}

let sesClient = null
function getMailer() {
  if (sesClient) return sesClient
  const env = process.env
  if (!env.SES_SECRET_ID || !env.SES_SECRET_KEY) return null
  sesClient = new ses.ses.v20201002.Client({
    credential: { secretId: env.SES_SECRET_ID.trim(), secretKey: env.SES_SECRET_KEY.trim() },
    region: SES_REGION,
    profile: { httpProfile: { reqTimeout: 8 } }
  })
  return sesClient
}

async function send(openid, email) {
  if (!EMAIL_RE.test(email) || email.length > 100) return { success: false, message: '请填写正确的邮箱' }
  if (!ALLOW_ANY_EMAIL && !STUDENT_RE.test(email)) return { success: false, message: '请使用学校邮箱（.edu）' }
  if (await takenByOther(email, openid)) return { success: false, message: '这个邮箱已经验证过别的账号' }

  const mailer = getMailer()
  if (!mailer) return { success: false, message: '邮件服务还没配置好' }

  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const prev = await getDoc('email_codes', openid)
  if (prev && now - prev.sent_at < RESEND_GAP_MS) return { success: false, message: '发送太频繁，稍后再试' }
  const dayCount = prev && prev.day === today ? prev.day_count : 0
  if (dayCount >= DAILY_LIMIT) return { success: false, message: '今天发送次数太多了，明天再试' }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  try {
    await mailer.SendEmail({
      FromEmailAddress: SES_FROM,
      Destination: [email],
      Subject: '明尼助手邮箱验证码：' + code,
      Template: { TemplateID: SES_TEMPLATE_ID, TemplateData: JSON.stringify({ code: code }) },
      TriggerType: 1 // 触发类：验证码走即时通道
    })
  } catch (e) {
    console.error('发信失败：', e.code, e.message)
    // 控制台「日志」页经常查不到记录，错误码直接带回前端，用户截图就能定位
    if (/Receiver|EmailAddr|Blacklist/i.test(e.code || '')) return { success: false, message: '邮件发送失败，检查一下邮箱地址' }
    return { success: false, message: '发送失败 ' + (e.code || e.message || '未知错误') }
  }

  // 存的是哈希，库里看不到明文验证码
  await db.collection('email_codes').doc(openid).set({
    data: {
      email: email,
      code_hash: hashCode(openid, code),
      expires_at: now + CODE_TTL_MS,
      attempts: 0,
      sent_at: now,
      day: today,
      day_count: dayCount + 1
    }
  })
  return { success: true }
}

async function verify(openid, email, code) {
  const rec = await getDoc('email_codes', openid)
  if (!rec || rec.email !== email || !rec.code_hash) return { success: false, message: '请先发送验证码' }
  if (Date.now() > rec.expires_at) return { success: false, message: '验证码已过期，重新发送一个' }
  if (rec.attempts >= MAX_ATTEMPTS) return { success: false, message: '错误次数太多，重新发送一个' }

  if (hashCode(openid, String(code || '').trim()) !== rec.code_hash) {
    await db.collection('email_codes').doc(openid).update({ data: { attempts: db.command.inc(1) } })
    return { success: false, message: '验证码不对' }
  }
  if (await takenByOther(email, openid)) return { success: false, message: '这个邮箱已经验证过别的账号' }

  const isStudent = STUDENT_RE.test(email)
  await db.collection('user_emails').doc(openid).set({
    data: { email: email, verified_at: db.serverDate() }
  })
  await db.collection('users').where({ openid: openid }).update({
    data: { email_verified: true, is_student: isStudent }
  })
  // 用掉就作废；保留发送计数，防止验证完立刻换邮箱刷发信
  await db.collection('email_codes').doc(openid).update({ data: { code_hash: '' } })

  return { success: true, email: email, isStudent: isStudent }
}

exports.main = async (event) => {
  if (event && event.__warmup) return { success: true, warmed: true }
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '未登录' }

  try {
    await ensureCollections()
    const email = String(event.email || '').trim().toLowerCase()
    if (event.action === 'send') return await send(openid, email)
    if (event.action === 'verify') return await verify(openid, email, event.code)
    return { success: false, message: '未知操作' }
  } catch (err) {
    console.error('emailVerify 出错：', err)
    return { success: false, message: '出错了，请重试' }
  }
}
