const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 帖子留言板。二手 / 转租 / 委托三个详情页共用。
//
// 定位刻意做成【公开的异步问答】，不是私聊：
//   - 所有人可见，所以它和帖子本身是同一类 UGC，走同一套治理（机检 + 举报 + 删除），
//     不用把平台升级成「通信服务提供者」那个量级
//   - 不实时。云环境在国内、用户在美国，跨太平洋 300ms 做实时聊天体验很差
//   - 一问一答用 reply_to_name 平铺展示，不做嵌套树——「还在吗」「在的」
//     这种对话两层就够了，树形结构在手机上也难点
//
// 和 getDetail 一样的铁律：openid 只在服务端流转，绝不下发给客户端。

const TYPES = {
  item:   { collection: 'secondhand_items', adminRole: 'market_admin', label: '二手' },
  sublet: { collection: 'sublet_items',     adminRole: 'sublet_admin', label: '转租' },
  task:   { collection: 'task_items',       adminRole: 'task_admin',   label: '委托' }
}

const MAX_LEN = 200

function timeText(value) {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 一次把涉及到的人的昵称头像查出来，别在循环里一条条查
async function loadUsers(openids) {
  const ids = [...new Set(openids.filter(Boolean))]
  if (!ids.length) return {}
  const res = await db.collection('users')
    .where({ openid: _.in(ids) })
    .field({ openid: true, nickname: true, avatarUrl: true })
    .limit(100)
    .get()
  const map = {}
  res.data.forEach(u => { map[u.openid] = u })
  return map
}

async function myRoles(openid) {
  if (!openid) return []
  const res = await db.collection('users')
    .where({ openid: openid }).field({ roles: true }).limit(1).get()
  return (res.data[0] && res.data[0].roles) || []
}

// 帖子的发布者。留言要通知他，删除权限也要认他。
async function postOwner(cfg, targetId) {
  try {
    const res = await db.collection(cfg.collection).doc(targetId).get()
    return (res.data && res.data._openid) || ''
  } catch (e) {
    return ''
  }
}

async function postTitle(cfg, targetId) {
  try {
    const res = await db.collection(cfg.collection).doc(targetId).get()
    return (res.data && res.data.title) || ''
  } catch (e) {
    return ''
  }
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const cfg = TYPES[event.targetType]

  try {
    switch (event.action) {

      case 'list': {
        if (!cfg || !event.targetId) return { success: false, message: '参数不对' }

        const res = await db.collection('messages')
          .where({ target_type: event.targetType, target_id: event.targetId })
          .orderBy('created_at', 'asc')
          .limit(200)
          .get()

        const owner = await postOwner(cfg, event.targetId)
        const users = await loadUsers(res.data.map(m => m.author).concat([owner]))
        const roles = await myRoles(openid)
        const isAdmin = roles.indexOf(cfg.adminRole) !== -1 || roles.indexOf('super_admin') !== -1

        return {
          success: true,
          // 楼主自己进来时前端要把输入框的占位改成「回复买家」
          isOwner: !!openid && openid === owner,
          messages: res.data.map(m => {
            const u = users[m.author] || {}
            return {
              _id: m._id,
              content: m.content,
              reply_to_name: m.reply_to_name || '',
              nickname: u.nickname || '同学',
              avatarUrl: u.avatarUrl || '',
              // 是不是楼主发的，前端给个「楼主」角标
              isPoster: !!m.author && m.author === owner,
              isMine: !!openid && m.author === openid,
              // 自己的、自己帖子下的、管理员，都能删
              canDelete: !!openid && (m.author === openid || openid === owner || isAdmin),
              timeText: timeText(m.created_at)
              // 注意：author（openid）不在返回值里
            }
          })
        }
      }

      case 'add': {
        if (!openid) return { success: false, message: '请先登录' }
        if (!cfg || !event.targetId) return { success: false, message: '参数不对' }

        const content = String(event.content || '').trim().slice(0, MAX_LEN)
        if (!content) return { success: false, message: '说点什么吧' }

        // 帖子没了就别再往上贴留言
        const owner = await postOwner(cfg, event.targetId)
        if (!owner) return { success: false, message: '内容已不存在' }

        // 防连点和刷屏：同一个人对同一条帖子，一分钟内不能发一模一样的话
        const since = new Date(Date.now() - 60000)
        const dup = await db.collection('messages').where({
          author: openid,
          target_id: event.targetId,
          content: content,
          created_at: _.gt(since)
        }).count()
        if (dup.total > 0) return { success: false, message: '刚发过一样的内容了' }

        await db.collection('messages').add({
          data: {
            target_type: event.targetType,
            target_id: event.targetId,
            author: openid,
            content: content,
            // 只存一个显示用的名字，不存被回复者的 openid——
            // 平铺展示成「回复 小明：…」就够了，不用把关系也建起来
            reply_to_name: String(event.replyToName || '').trim().slice(0, 20),
            created_at: new Date()
          }
        })

        // 通知楼主有人留言。自己给自己的帖子留言不通知。
        // 发不出去很正常（对方没授权、票用完了），绝不能让它影响留言本身。
        if (owner !== openid) {
          try {
            const users = await loadUsers([openid])
            const me = users[openid] || {}
            await cloud.callFunction({
              name: 'sendSubscribe',
              data: {
                tpl: 'inquiry',
                toUser: owner,
                page: 'pages/home/home',
                data: {
                  who: me.nickname || '有位同学',
                  kind: cfg.label,
                  content: (await postTitle(cfg, event.targetId)) || content,
                  time: new Date().toLocaleString('zh-CN', { hour12: false })
                }
              }
            })
          } catch (e) {
            console.warn('留言通知发送失败（不影响留言）：', e)
          }
        }

        return { success: true }
      }

      case 'remove': {
        if (!openid) return { success: false, message: '请先登录' }
        if (!event.messageId) return { success: false, message: '参数不对' }

        const doc = await db.collection('messages').doc(event.messageId).get()
        const msg = doc.data
        if (!msg) return { success: false, message: '留言不存在' }

        const typeCfg = TYPES[msg.target_type]
        const owner = typeCfg ? await postOwner(typeCfg, msg.target_id) : ''
        const roles = await myRoles(openid)
        const isAdmin = typeCfg &&
          (roles.indexOf(typeCfg.adminRole) !== -1 || roles.indexOf('super_admin') !== -1)

        // 权限在服务端再判一次，不信前端传来的 canDelete
        if (msg.author !== openid && openid !== owner && !isAdmin) {
          return { success: false, message: '没有权限' }
        }

        await db.collection('messages').doc(event.messageId).remove()
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + event.action }
    }
  } catch (err) {
    console.error('messages 失败：', event.action, err)
    return { success: false, message: '操作失败，请重试' }
  }
}
