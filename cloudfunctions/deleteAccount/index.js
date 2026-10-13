const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 注销账号。按《个人信息保护法》第 47 条，用户注销后要删除个人信息；
// 法律另有保存期限的，只保存、不再处理。
//   - 删：资料、邮箱、发布的帖子和图片、留言、反馈、开团提醒、队员身份
//   - 留：订单。《电子商务法》第 31 条要求交易信息自交易完成起保存不少于三年，
//     结算和纠纷处理也要用。只断开和账号的关联（buyer 清空、昵称改成已注销），
//     手机号、地址这些交易信息原样留着
//
// 每一步都是「查到什么删什么」，中途超时或失败，用户再点一次能接着删完。
// users 放最后删：前面没删干净之前，账号还在，用户还能重试。

const POSTS = ['secondhand_items', 'sublet_items', 'task_items', 'group_items']
const ACTIVE_ORDER = ['forming', 'confirming', 'pending', 'accepted', 'delivering']

// 集合还没建（比如从没人加过配送队）不算失败，别的错照常抛
function isNoCollection(err) {
  const text = String((err && (err.errMsg || err.message)) || '')
  return (err && err.errCode === -502005) || /COLLECTION_NOT_EXIST|collection not exist/i.test(text)
}

function skipMissing(promise) {
  return promise.catch(err => {
    if (!isNoCollection(err)) throw err
  })
}

function cloudFiles(list) {
  return list.filter(f => typeof f === 'string' && f.indexOf('cloud://') === 0)
}

// 注销前必须先处理完的事。有一件就不往下走，什么都不删
async function blocker(openid) {
  const shop = await db.collection('shops').where({ owner: openid }).count()
  if (shop.total > 0) return '你还开着小店，先在「小店设置」里删除小店'

  const team = await skipMissing(db.collection('delivery_teams').where({ admin: openid }).count())
  if (team && team.total > 0) return '你还是配送队队长，联系客服处理队伍后再注销'

  const orders = await db.collection('shop_orders')
    .where({ buyer: openid, status: _.in(ACTIVE_ORDER) })
    .count()
  if (orders.total > 0) return '还有 ' + orders.total + ' 单没完成，完成或取消后再注销'

  return ''
}

async function removePosts(openid) {
  const files = []
  const postIds = []
  for (const name of POSTS) {
    const res = await skipMissing(db.collection(name)
      .where({ _openid: openid })
      .field({ images: true, thumb: true })
      .limit(1000)
      .get())
    if (!res || !res.data.length) continue
    res.data.forEach(p => {
      postIds.push(p._id)
      files.push(...(p.images || []), p.thumb)
    })
    await db.collection(name).where({ _openid: openid }).remove()
  }
  return { files: files, postIds: postIds }
}

exports.main = async (event, context) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '获取身份失败' }

  try {
    const reason = await blocker(openid)
    if (reason) return { success: false, message: reason }

    const posts = await removePosts(openid)

    // 自己的留言，以及别人在自己帖子下的留言（帖子没了，留言也没处显示）
    const messages = db.collection('messages')
    await skipMissing(messages.where({ author: openid }).remove())
    for (let i = 0; i < posts.postIds.length; i += 100) {
      await skipMissing(messages.where({ target_id: _.in(posts.postIds.slice(i, i + 100)) }).remove())
    }

    await Promise.all([
      skipMissing(db.collection('shop_subscriptions').where({ user: openid }).remove()),
      skipMissing(db.collection('team_members').where({ openid: openid }).remove()),
      skipMissing(db.collection('feedback').where({ _openid: openid }).remove()),
      // 举报记录是管理留档，留着；只去掉举报人，处理完不会再通知到这个人
      skipMissing(db.collection('reports').where({ reporter: openid }).update({ data: { reporter: '' } })),
      db.collection('user_emails').doc(openid).remove().catch(() => {}),
      db.collection('email_codes').doc(openid).remove().catch(() => {}),
      skipMissing(db.collection('shop_orders').where({ buyer: openid }).update({
        data: { buyer: '', buyer_nickname: '已注销用户', buyer_deleted_at: new Date() }
      }))
    ])

    const users = await db.collection('users').where({ openid: openid }).get()
    users.data.forEach(u => posts.files.push(u.avatarUrl))
    await db.collection('users').where({ openid: openid }).remove()

    // 图片删不掉不影响注销结果。deleteFile 一次最多 50 个
    const files = cloudFiles(posts.files)
    for (let i = 0; i < files.length; i += 50) {
      try {
        await cloud.deleteFile({ fileList: files.slice(i, i + 50) })
      } catch (e) {
        console.warn('删除图片失败（不影响注销）：', e)
      }
    }

    return { success: true }
  } catch (err) {
    console.error('注销失败：', err)
    return { success: false, message: '注销失败，请稍后再试' }
  }
}
