// 屏蔽用户。App Store 对有用户发布内容的应用要求「能屏蔽骚扰你的人」（审核条款 1.2），
// 小程序这边也一起有。屏蔽后，对方的帖子、店铺和留言在你这里都看不到；对方不会收到通知。
//
// openid 只在服务端流转（同 getDetail / messages），所以：
//   - 屏蔽时前端只传「哪条内容」（targetType + targetId）或公开主页的 uid，作者在这里查
//   - 列表页是前端直连数据库查的，拿不到作者，这里直接把「被屏蔽的人发的内容 _id」算好发回去，
//     前端按 _id 过滤（见 utils/blocks.js）
//   - 留言在 messages 云函数里按作者过滤
//
// 记录在 user_blocks（_id = 屏蔽人 openid + '_' + 被屏蔽人 openid），第一次用时自动建，
// 建好后控制台权限改成「所有用户不可读写」。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 内容类型 → 集合和作者字段。云函数写库的集合没有 _openid，用显式的 owner / author
const SOURCES = {
  item: { collection: 'secondhand_items', field: '_openid' },
  sublet: { collection: 'sublet_items', field: '_openid' },
  task: { collection: 'task_items', field: '_openid' },
  group: { collection: 'group_items', field: '_openid' },
  shop: { collection: 'shops', field: 'owner' },
  message: { collection: 'messages', field: 'author' }
}
// 列表页需要隐藏的几类（留言在 messages 云函数里过滤，不走这里）
const HIDE_TYPES = ['item', 'sublet', 'task', 'group', 'shop']

let ready = false
async function ensureCollection() {
  if (ready) return
  try { await db.createCollection('user_blocks') } catch (e) { /* 已经存在 */ }
  ready = true
}

async function authorOf(type, id) {
  const src = SOURCES[type]
  if (!src || !id) return ''
  try {
    const doc = (await db.collection(src.collection).doc(id).get()).data
    return (doc && doc[src.field]) || ''
  } catch (e) {
    return ''
  }
}

async function openidOfUid(uid) {
  if (!uid) return ''
  try {
    return ((await db.collection('users').doc(uid).get()).data || {}).openid || ''
  } catch (e) {
    return ''
  }
}

async function blockedOpenids(openid) {
  const res = await db.collection('user_blocks').where({ owner: openid }).limit(1000).get()
  return res.data.map(d => d.target)
}

exports.main = async (event) => {
  if (event && event.__warmup) return { success: true, warmed: true }
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请先登录' }

  try {
    await ensureCollection()

    if (event.action === 'block') {
      const target = event.uid ? await openidOfUid(event.uid) : await authorOf(event.targetType, event.targetId)
      if (!target) return { success: false, message: '内容不存在' }
      if (target === openid) return { success: false, message: '不能屏蔽自己' }
      await db.collection('user_blocks').doc(openid + '_' + target).set({
        data: { owner: openid, target: target, created_at: db.serverDate() }
      })
      return { success: true }
    }

    if (event.action === 'unblock') {
      const target = await openidOfUid(event.uid)
      if (!target) return { success: false, message: '用户不存在' }
      await db.collection('user_blocks').doc(openid + '_' + target).remove().catch(() => {})
      return { success: true }
    }

    if (event.action === 'list') {
      const targets = await blockedOpenids(openid)
      const hidden = {}
      HIDE_TYPES.forEach(k => { hidden[k] = [] })
      if (!targets.length) return { success: true, users: [], hidden: hidden }

      const [users] = await Promise.all([
        db.collection('users').where({ openid: _.in(targets) })
          .field({ nickname: true, avatarUrl: true }).limit(1000).get(),
        Promise.all(HIDE_TYPES.map(async k => {
          const src = SOURCES[k]
          const res = await db.collection(src.collection)
            .where({ [src.field]: _.in(targets) })
            .field({ _id: true }).limit(1000).get()
            .catch(() => ({ data: [] }))
          hidden[k] = res.data.map(d => d._id)
        }))
      ])
      return {
        success: true,
        // 对外只给 uid（users 的 _id），openid 不下发
        users: users.data.map(u => ({ uid: u._id, nickname: u.nickname || '', avatarUrl: u.avatarUrl || '' })),
        hidden: hidden
      }
    }

    return { success: false, message: '未知操作' }
  } catch (err) {
    console.error('userBlock 出错：', err)
    return { success: false, message: '出错了，请重试' }
  }
}
