const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 和 getDetail 的 TYPES 保持一致：按钮显隐看那边，真正的删除权限看这边
const TYPES = {
  item: { collection: 'secondhand_items', adminRole: 'market_admin' },
  sublet: { collection: 'sublet_items', adminRole: 'sublet_admin' },
  task: { collection: 'task_items', adminRole: 'task_admin' },
  group: { collection: 'group_items', adminRole: 'group_admin' }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID   // 调用者的真实身份（不可伪造）
  const itemId = event.itemId       // 前端传来的：要删哪条
  const cfg = TYPES[event.type || 'item']   // 旧版二手详情页不传 type
  if (!cfg || !itemId) return { success: false, message: '参数不对' }

  try {
    // 1. 先查出这条帖子
    const itemRes = await db.collection(cfg.collection).doc(itemId).get()
    const item = itemRes.data

    // 2. 查调用者是不是这个板块的管理员
    const userRes = await db.collection('users').where({ openid: openid }).get()
    let roles = []
    if (userRes.data.length > 0) {
      roles = userRes.data[0].roles || (userRes.data[0].role ? [userRes.data[0].role] : [])
    }
    const isAdmin = roles.includes(cfg.adminRole) || roles.includes('super_admin')

    // 3. 判断是不是发布者本人
    const isOwner = (item._openid === openid)

    // 4. 只有本人或管理员能删
    if (!isOwner && !isAdmin) {
      return { success: false, message: '无权限删除' }
    }

    // 5. 通过校验，执行删除。小程序端直删受数据库权限限制，管理员删不了别人的帖子，所以统一走这里
    await db.collection(cfg.collection).doc(itemId).remove()
    return { success: true }

  } catch (err) {
    return { success: false, error: err }
  }
}
