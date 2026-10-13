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
  group: 'group_items',
  shop: 'shops',
  team: 'delivery_teams',
  message: 'messages'
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
            // 买家也再查不到自己下过的单。改成 takedown 标记：列表不再显示，
            // 也开不了团、下不了单（见 shopBrowse / shopManage / buyerOrders）。
            await db.collection(collection).doc(report.targetId).update({
              data: {
                status: 'closed',
                takedown: true,
                takedown_at: new Date(),
                updated_at: new Date()
              }
            })
            // 还在拼团中的场次就此作废，没成团的单一起取消。已成团的单留给店长处理
            await db.collection('shop_sessions')
              .where({ shop_id: report.targetId, state: 'open' })
              .update({ data: { state: 'cancelled', updated_at: new Date() } })
              .catch(() => {})
            await db.collection('shop_orders')
              .where({ shop_id: report.targetId, status: 'forming' })
              .update({ data: { status: 'cancelled', cancel_reason: '店铺已下架', updated_at: new Date() } })
          } else if (report.targetType === 'team') {
            // 配送队同理：底下挂着历史请求和送达照片，只下架不删。
            // 下架后不出现在挑队列表、收不到群发；管理员可在「配送管理」里恢复
            await db.collection(collection).doc(report.targetId).update({
              data: {
                takedown: true,
                takedown_reason: 'report',
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

    // 告诉举报人处理完了。没这一步，举报就是个许愿池——
    // 用户举报一次没下文，第二次就不会再举报了。
    // 发不出去很正常（对方没授权、模板还没申请），不能影响处理本身。
    if (report.reporter) {
      try {
        const now = new Date()
        const pad = n => (n < 10 ? '0' + n : '' + n)
        // 「处理日期」在模板里是 time 类型（24 小时制，可带日期），
        // 只发年月日会被判格式不符，要带上时分
        await cloud.callFunction({
          name: 'sendSubscribe',
          data: {
            tpl: 'reportResult',
            toUser: report.reporter,
            data: {
              content: report.targetTitle || '你举报的内容',
              result: action === 'delete'
                ? ((report.targetType === 'shop' || report.targetType === 'team') ? '已下架' : '已删除')
                : '未发现违规',
              date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
              tip: action === 'delete'
                ? '感谢反馈，内容已下架'
                : '核实后未发现违规，感谢关注'
            }
          }
        })
      } catch (e) {
        console.warn('举报结果通知发送失败（不影响处理）：', e)
      }
    }

    return { success: true }
  } catch (err) {
    console.error('处理举报失败：', err)
    return { success: false, message: '处理失败' }
  }
}
