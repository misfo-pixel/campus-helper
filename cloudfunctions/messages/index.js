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
  item:   { collection: 'secondhand_items', adminRole: 'market_admin', label: '二手', page: 'pages/itemdetail/itemdetail' },
  sublet: { collection: 'sublet_items',     adminRole: 'sublet_admin', label: '转租', page: 'pages/subletdetail/subletdetail' },
  task:   { collection: 'task_items',       adminRole: 'task_admin',   label: '委托', page: 'pages/taskdetail/taskdetail' }
}

const MAX_LEN = 200

// 通知最多等这么久。云函数默认 3 秒超时，前面还有好几次读写；
// sendSubscribe 一冷启动就可能吃掉一两秒，等满了整个 add 超时，
// 前端报「发送失败」而留言其实已经写进去了——用户重发又撞上防重复，
// 看起来就是「留言用不了」。通知是锦上添花，宁可丢一条也不能拖垮留言。
const NOTIFY_BUDGET_MS = 1500

function within(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))])
}

// messages 集合要在控制台手动建，漏建时每次读写都报 -502005。
// 云函数自己建一次，每个实例只试一次；已存在时 createCollection 会报错，吞掉即可。
let collectionReady = false
async function ensureCollection() {
  if (collectionReady) return
  try {
    await db.createCollection('messages')
  } catch (e) { /* 已经存在 */ }
  collectionReady = true
}

function isNoCollection(err) {
  const text = String((err && (err.errMsg || err.message)) || '')
  return (err && err.errCode === -502005) || /COLLECTION_NOT_EXIST|collection not exist/i.test(text)
}

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

// 帖子的发布者和标题，一次读出来。发布者要收通知，删除权限也要认他。
// 帖子不存在时 owner 为空串。
async function loadPost(cfg, targetId) {
  try {
    const res = await db.collection(cfg.collection).doc(targetId).get()
    return { owner: (res.data && res.data._openid) || '', title: (res.data && res.data.title) || '' }
  } catch (e) {
    return { owner: '', title: '' }
  }
}

async function postOwner(cfg, targetId) {
  return (await loadPost(cfg, targetId)).owner
}

// 被回复的那条留言的作者。openid 只在这里查、只在服务端用。
async function replyTarget(messageId) {
  if (!messageId) return ''
  try {
    const res = await db.collection('messages').doc(messageId).get()
    return (res.data && res.data.author) || ''
  } catch (e) {
    return ''
  }
}

function notify(toUser, cfg, targetId, payload) {
  return cloud.callFunction({
    name: 'sendSubscribe',
    data: {
      tpl: 'inquiry',
      toUser: toUser,
      page: cfg.page + '?id=' + targetId,
      data: Object.assign({ kind: cfg.label, time: new Date().toLocaleString('zh-CN', { hour12: false }) }, payload)
    }
  }).catch(e => console.warn('留言通知发送失败（不影响留言）：', e))
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const cfg = TYPES[event.targetType]

  try {
    switch (event.action) {

      case 'list': {
        if (!cfg || !event.targetId) return { success: false, message: '参数不对' }

        // 三次读互不依赖，并行。集合还没建（一条留言都没有过）时当空列表。
        const [res, owner, roles] = await Promise.all([
          db.collection('messages')
            .where({ target_type: event.targetType, target_id: event.targetId })
            .orderBy('created_at', 'asc')
            .limit(200)
            .get()
            .catch(err => {
              if (isNoCollection(err)) return { data: [] }
              throw err
            }),
          postOwner(cfg, event.targetId),
          myRoles(openid)
        ])
        const users = await loadUsers(res.data.map(m => m.author).concat([owner]))
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

        await ensureCollection()

        // 帖子没了就别再往上贴留言
        const [post, replyAuthor] = await Promise.all([
          loadPost(cfg, event.targetId),
          replyTarget(event.replyToId)
        ])
        const owner = post.owner
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
            // 被回复留言的 id，只用来在服务端找回作者发通知，不下发
            reply_to_id: String(event.replyToId || ''),
            created_at: new Date()
          }
        })

        // 两个人可能要收通知，都不给自己发：
        //   楼主 —— 帖子下有新留言（票是他发帖时授权的）
        //   被回复的人 —— 有人回复了他（票是他当初留言时授权的，
        //                  这正是「问了一句还在吗，等回音」的那一刻）
        // 被回复的就是楼主时只发一条。
        // 发不出去很正常（对方没授权、票用完了），绝不能让它影响留言本身。
        const tasks = []
        const needOwner = owner !== openid
        const needReply = replyAuthor && replyAuthor !== openid && replyAuthor !== owner
        if (needOwner || needReply) {
          const me = (await loadUsers([openid]))[openid] || {}
          const who = me.nickname || '有位同学'
          if (needOwner) tasks.push(notify(owner, cfg, event.targetId, { who: who, content: post.title || content }))
          if (needReply) tasks.push(notify(replyAuthor, cfg, event.targetId, { who: who + ' 回复你', content: content }))
        }
        if (tasks.length) await within(Promise.all(tasks), NOTIFY_BUDGET_MS)

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
