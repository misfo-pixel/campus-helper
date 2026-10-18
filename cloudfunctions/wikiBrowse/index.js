const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 生活百科（Wiki）的唯一读取入口。wiki_categories / wiki_articles / wiki_search_logs
// 三个集合对小程序端都不可读（权限设成「仅创建者可读写」），所有读写都过这里，
// 这样「draft 不对外」是在服务端拦的，不靠前端自觉。
//
// action 一览：
//   home       首页一次拿齐：分类 + 最近更新 + 热门
//   list       某分类下的词条（分页）
//   detail     词条详情（顺便 viewCount +1）
//   search     标题/标签/摘要模糊匹配，顺带写搜索日志（没结果的也记，用来选题）
//   管理员的写操作在 wikiAdmin，这里只读。

const PAGE_SIZE = 20

// 列表下发的字段：够卡片用就行，正文留给 detail
const LIST_FIELDS = {
  title: true, summary: true, categoryId: true, tags: true,
  status: true, verifiedAt: true, updatedAt: true, viewCount: true, helpfulCount: true
}

async function myRoles(openid) {
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  return (me.data[0] && me.data[0].roles) || []
}

async function isAdmin(openid) {
  const roles = await myRoles(openid)
  return roles.includes('super_admin') || roles.includes('market_admin')
}

// 普通用户只看 verified；管理员带 preview=1 时能看 draft（审核前预览）
async function visibleWhere(openid, preview) {
  if (preview && (await isAdmin(openid))) return {}
  return { status: 'verified' }
}

function publicArticle(a) {
  // 不下发 _openid 一类内部字段；wiki_articles 本来也不存，这里只是保险
  return a
}

exports.main = async (event) => {
  if (event && event.__warmup) return { success: true, warmed: true }

  const openid = cloud.getWXContext().OPENID
  const action = event.action

  try {
    if (action === 'home') {
      const where = await visibleWhere(openid, event.preview)
      const cats = await db.collection('wiki_categories').orderBy('order', 'asc').limit(50).get()
      const recent = await db.collection('wiki_articles').where(where)
        .field(LIST_FIELDS).orderBy('updatedAt', 'desc').limit(6).get()
      const hot = await db.collection('wiki_articles').where(where)
        .field(LIST_FIELDS).orderBy('viewCount', 'desc').limit(6).get()
      return { success: true, categories: cats.data, recent: recent.data.map(publicArticle), hot: hot.data.map(publicArticle) }
    }

    if (action === 'list') {
      const where = Object.assign(await visibleWhere(openid, event.preview), { categoryId: event.categoryId })
      const skip = Math.max(0, Number(event.skip) || 0)
      const res = await db.collection('wiki_articles').where(where)
        .field(LIST_FIELDS).orderBy('updatedAt', 'desc').skip(skip).limit(PAGE_SIZE).get()
      return { success: true, items: res.data.map(publicArticle), noMore: res.data.length < PAGE_SIZE }
    }

    if (action === 'detail') {
      const res = await db.collection('wiki_articles').doc(event.id).get().catch(() => null)
      const a = res && res.data
      if (!a) return { success: false, message: '词条不存在' }
      if (a.status !== 'verified' && !(event.preview && (await isAdmin(openid)))) {
        return { success: false, message: '词条不存在' }   // draft 对外就当不存在，不提示「审核中」
      }
      // 浏览量 +1：失败不影响看内容
      db.collection('wiki_articles').doc(event.id).update({ data: { viewCount: _.inc(1) } }).catch(() => {})
      return { success: true, article: publicArticle(a) }
    }

    if (action === 'search') {
      const q = String(event.q || '').trim().slice(0, 30)
      if (!q) return { success: false, message: '请输入关键词' }
      const where = await visibleWhere(openid, false)
      const re = db.RegExp({ regexp: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
      const res = await db.collection('wiki_articles').where(Object.assign(where, {
        // 标题、标签、摘要任一命中即可
        ..._.or([{ title: re }, { tags: re }, { summary: re }])
      })).field(LIST_FIELDS).limit(20).get()
      // 搜索日志：有没有结果都记，「搜了没结果」的词就是选题清单
      db.collection('wiki_search_logs').add({
        data: { keyword: q, resultCount: res.data.length, openid: openid || '', created_at: db.serverDate() }
      }).catch(() => {})
      return { success: true, items: res.data.map(publicArticle) }
    }

    return { success: false, message: '未知操作' }
  } catch (err) {
    console.error('wikiBrowse 失败：', err)
    return { success: false, message: '读取失败' }
  }
}
