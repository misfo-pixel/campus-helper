// 三个详情页（二手 / 转租 / 任务）的统一数据源。
//
// 为什么详情页不能直接查数据库：云数据库每条文档都自带 _openid 字段，前端 get()
// 时会一起返回，等于把发布者的永久身份标识发给了任何打开这个页面的人。
// 放到云函数里，就能在服务端摘掉它再返回。
//
// 顺带把三件事合并成一次调用（原来是三趟）：
//   1. 商品内容   2. 发布者的昵称头像   3. 当前用户能不能删
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 延迟测量用：顶层代码只在实例启动时执行一次，所以 n === 1 即冷启动。
// 只往返回值里加一个 _debug 字段，前端现有代码完全不受影响。
const INSTANCE = Math.random().toString(36).slice(2, 8)
const BOOTED_AT = Date.now()
let calls = 0

function debugInfo(t0) {
  return { instance: INSTANCE, n: calls, instanceAgeMs: t0 - BOOTED_AT, execMs: Date.now() - t0 }
}

const TYPES = {
  item: { collection: 'secondhand_items', adminRole: 'market_admin' },
  sublet: { collection: 'sublet_items', adminRole: 'sublet_admin' },
  task: { collection: 'task_items', adminRole: 'task_admin' }
}

async function findUser(openid, fields) {
  if (!openid) return null
  const res = await db.collection('users')
    .where({ openid: openid }).field(fields).limit(1).get()
  return res.data[0] || null
}

exports.main = async (event) => {
  const t0 = Date.now()
  // 计数必须放在保温拦截之前：保温调用也占用了这个容器的一次生命。
  // 放在后面的话，保温之后用户的第一次真实调用会被误报成 n=1「冷启动」，
  // 测量数据就开始骗人了——而我们正是靠这个数判断要不要迁服务器。
  calls += 1

  // 保温调用只是为了让容器活着，不执行业务
  if (event && event.__warmup) return { success: true, warmed: true, n: calls }

  const cfg = TYPES[event.type]
  if (!cfg || !event.id) return { success: false, message: '参数不对' }

  const myOpenid = cloud.getWXContext().OPENID

  let doc
  try {
    const res = await db.collection(cfg.collection).doc(event.id).get()
    doc = res.data
  } catch (err) {
    // 已删除、已下架，或 id 本身是坏的。分享卡片放久了很常见，不是异常。
    return { success: false, message: '内容不存在' }
  }
  if (!doc) return { success: false, message: '内容不存在' }

  const ownerOpenid = doc._openid
  delete doc._openid          // ← 关键一行：openid 到此为止，不下发

  // 审核中 / 没通过的帖子只给发布者自己看。列表页本来就查不到它们，
  // 但发布者可能审核还没结束就把详情页转发出去了——没审过的内容不能经这条路漏出去
  const isOwner = !!myOpenid && myOpenid === ownerOpenid
  if (!isOwner && (doc.status === 'reviewing' || doc.status === 'rejected')) {
    return { success: false, message: '内容审核中' }
  }

  // 发布者资料 和 我的角色 互不依赖，并发查
  const pair = await Promise.all([
    findUser(ownerOpenid, { nickname: true, avatarUrl: true }),
    findUser(myOpenid, { roles: true })
  ])
  const owner = pair[0]
  const me = pair[1]

  const roles = (me && me.roles) || []

  return {
    success: true,
    item: doc,
    seller: {
      nickname: owner ? (owner.nickname || '') : '',
      avatarUrl: owner ? (owner.avatarUrl || '') : '',
      uid: owner ? owner._id : ''      // 对外可分享的编号，不是 openid
    },
    isOwner: isOwner,
    // 前端拿它控制按钮显隐；真正的删除权限由 deleteItem 云函数自己再校验一次
    canDelete: isOwner || roles.indexOf(cfg.adminRole) !== -1 || roles.indexOf('super_admin') !== -1,
    _debug: debugInfo(t0)
  }
}
