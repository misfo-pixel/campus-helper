const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 用户举报违规内容。举报入口 + 管理员处理是微信对 UGC 小程序的硬性要求，
// 和内容安全接口（contentCheck）一起构成「先机检、后人工」的两道关。

const COLLECTIONS = {
  item: 'secondhand_items',
  sublet: 'sublet_items',
  task: 'task_items',
  shop: 'shops',
  message: 'messages'
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const targetType = event.targetType
  const targetId = event.targetId
  const reason = event.reason
  const detail = (event.detail || '').slice(0, 500)

  const collection = COLLECTIONS[targetType]
  if (!collection || !targetId) return { success: false, message: '参数不完整' }
  if (!reason) return { success: false, message: '请选择举报原因' }

  try {
    // 同一个人对同一条内容只留一条待处理举报，防止刷
    const dup = await db.collection('reports').where({
      reporter: openid,
      targetType: targetType,
      targetId: targetId,
      status: 'pending'
    }).count()
    if (dup.total > 0) {
      return { success: false, message: '你已经举报过这条内容，我们正在处理' }
    }

    // 存一份被举报内容的快照：管理员列表不用回表查，
    // 而且内容被发布者自己删了之后也还能看到当初举报的是什么
    // 三种内容的字段名都不一样：
    //   帖子   title  + _openid（小程序端 add 自带）
    //   店铺   name   + owner  （云函数写库不带 _openid，归属显式存）
    //   留言   content+ author
    let title = ''
    let ownerOpenid = ''
    try {
      const doc = await db.collection(collection).doc(targetId).get()
      const d = doc.data || {}
      title = d.title || d.name || d.content || ''
      ownerOpenid = d._openid || d.owner || d.author || ''
    } catch (e) {
      console.warn('被举报内容已不存在：', targetType, targetId)
    }

    await db.collection('reports').add({
      data: {
        reporter: openid,
        targetType: targetType,
        targetId: targetId,
        targetTitle: title,
        targetOwner: ownerOpenid,
        reason: reason,
        detail: detail,
        status: 'pending',
        created_at: new Date()
      }
    })

    return { success: true }
  } catch (err) {
    console.error('提交举报失败：', err)
    return { success: false, message: '提交失败，请稍后重试' }
  }
}
