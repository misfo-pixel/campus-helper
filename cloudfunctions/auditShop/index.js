const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 商家入驻审核（超管）。
//
// 这是整个外卖模块里唯一需要管理员的地方，而且一家店一辈子只审一次，
// 跟「每单都要人确认收款」完全不是一个量级。
// 不能省：谁都能点一下就开店卖吃的，出了食品安全问题责任全指向平台。

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    // 饭搭子管理员天天跟商家打交道，商家入驻该由他们审；超管保留权限做兜底
    const me = await db.collection('users').where({ openid: openid }).limit(1).get()
    const roles = (me.data[0] && me.data[0].roles) || []
    if (!roles.includes('super_admin') && !roles.includes('food_admin')) {
      return { success: false, message: '没有权限' }
    }

    switch (action) {
      case 'list': {
        const res = await db.collection('shops')
          .where({ audit_status: event.status || 'pending' })
          .orderBy('created_at', 'desc')
          .limit(100)
          .get()
        return { success: true, shops: res.data }
      }

      case 'approve': {
        // 存一份当时看到的内容。商家事后改了资料，也能证明放行时核对的是什么，
        // 这是「平台只核对了信息」这个说法唯一的支撑材料。
        const doc = await db.collection('shops').doc(event.shopId).get()
        const s = doc.data || {}
        const snapshot = {
          name: s.name || '',
          description: s.description || '',
          category: s.category || '',
          delivery_area: s.delivery_area || '',
          business_hours: s.business_hours || '',
          payment_note: s.payment_note || '',
          contact_wechat: s.contact_wechat || '',
          license_confirmed: !!s.license_confirmed,
          license_image: s.license_image || ''
        }

        await db.collection('shops').doc(event.shopId).update({
          data: {
            audit_status: 'approved',
            audit_reason: '',
            audited_by: openid,
            audited_at: new Date(),
            audited_snapshot: snapshot
          }
        })
        return { success: true }
      }

      case 'reject': {
        await db.collection('shops').doc(event.shopId).update({
          data: {
            audit_status: 'rejected',
            audit_reason: event.reason || '',
            status: 'closed',
            audited_by: openid,
            audited_at: new Date()
          }
        })
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + action }
    }
  } catch (err) {
    console.error('auditShop 失败：', action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
