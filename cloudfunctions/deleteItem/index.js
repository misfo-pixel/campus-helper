const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID   // 调用者的真实身份（不可伪造）
  const itemId = event.itemId       // 前端传来的：要删哪条

  try {
    // 1. 先查出这条商品
    const itemRes = await db.collection('secondhand_items').doc(itemId).get()
    const item = itemRes.data

    // 2. 查调用者是不是管理员
    const userRes = await db.collection('users').where({ openid: openid }).get()
    const isAdmin = userRes.data.length > 0 && userRes.data[0].role === 'admin'

    // 3. 判断是不是发布者本人
    const isOwner = (item._openid === openid)

    // 4. 只有本人或管理员能删
    if (!isOwner && !isAdmin) {
      return { success: false, message: '无权限删除' }
    }

    // 5. 通过校验，执行删除
    await db.collection('secondhand_items').doc(itemId).remove()
    return { success: true }

  } catch (err) {
    return { success: false, error: err }
  }
}