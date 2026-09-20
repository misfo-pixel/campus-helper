const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 管理员处理举报：删掉违规内容，或者判定不违规驳回。
// 两种处理都会把 report 标成 handled 并留下处理人和时间，
// 这就是提审时要说明的「人工复核机制」。

const COLLECTIONS = {
  item: 'secondhand_items',
  sublet: 'sublet_items',
  task: 'task_items',
  shop: 'shops'
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const reportId = event.reportId
  const action = event.action   // 'delete' 删除内容 | 'dismiss' 驳回举报

  if (!reportId || !action) return { success: false, message: '参数不完整' }

  try {
    const me = await db.collection('users').where({ openid: openid }).limit(1).get()
    const roles = (me.data[0] && me.data[0].roles) || []
    if (!roles.includes('super_admin') && !roles.includes('market_admin')) {
      return { success: false, message: '没有权限' }
    }

    const reportDoc = await db.collection('reports').doc(reportId).get()
    const report = reportDoc.data
    if (!report) return { success: false, message: '举报不存在' }

    if (action === 'delete') {
      const collection = COLLECTIONS[report.targetType]
      if (collection) {
        // 内容可能已经被发布者自己删了，处理不到不算失败
        try {
          if (report.targetType === 'shop') {
            // 店铺不能直接删：底下挂着 shop_items 和历史订单，删了全成孤儿数据，
            // 买家也再查不到自己下过的单。改成强制关店 + takedown 标记，
            // shopManage 的 setStatus 据此不让商家自己再开回来。
            await db.collection(collection).doc(report.targetId).update({
              data: {
                status: 'closed',
                takedown: true,
                takedown_at: new Date(),
                updated_at: new Date()
              }
            })
          } else {
            await db.collection(collection).doc(report.targetId).remove()
          }
        } catch (e) {
          console.warn('待处理内容已不存在：', report.targetType, report.targetId)
        }
      }
    }

    await db.collection('reports').doc(reportId).update({
      data: {
        status: 'handled',
        action: action,
        handled_by: openid,
        handled_at: new Date()
      }
    })

    return { success: true }
  } catch (err) {
    console.error('处理举报失败：', err)
    return { success: false, message: '处理失败' }
  }
}
