// 用户公开主页的数据源。
//
// 为什么必须走云函数：主页链接会被转发给陌生人，链接里只能带一个不透明的编号
// （users 文档的随机 _id），不能带 openid——openid 是永久身份标识，散出去等于
// 给了别人一个永久追踪句柄。openid 只在这里、服务端内部使用，不下发给前端。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PAGE_LIMIT = 20
const POSTER_LIMIT = 80   // 和 utils/groupCover.js 的 MAX_ITEMS 一致

// 三种业务的差异收敛在这里，加板块只加一行
const TYPES = {
  item: {
    collection: 'secondhand_items',
    status: 'on_sale',
    field: { title: true, price: true, images: true, thumb: true, kind: true }
  },
  sublet: {
    collection: 'sublet_items',
    status: 'on_sale',
    field: { title: true, rent: true, rent_min: true, rent_max: true, images: true, thumb: true, room_type: true, address: true, kind: true }
  },
  task: {
    collection: 'task_items',
    status: 'open',      // 注意任务用的是 open，不是 on_sale
    field: { title: true, reward: true, images: true, thumb: true, deadline: true }
  },
  group: {
    collection: 'group_items',
    status: 'open',
    field: { title: true, kind: true, images: true, thumb: true, event_date: true }
  }
}

// 转发主页时拿哪件当封面、写进标题：最可能卖掉的那件。
// 判断很朴素：有照片的里面，留言问过的不同的人最多的（卖家自己回复不算），一样多就挑新的。
// 没有浏览量、收藏这类数据，留言是现成的、最能说明「有人想要」的信号
async function hottest(items, sellerOpenid) {
  const withPic = items.filter(it => ['want', 'seek'].indexOf(it.kind) === -1 && (it.thumb || (it.images || []).length))
  if (!withPic.length) return ''
  let msgs = []
  try {
    msgs = (await db.collection('messages')
      .where({ target_type: 'item', target_id: _.in(withPic.map(it => it._id)) })
      .field({ target_id: true, author: true })
      .limit(1000)
      .get()).data
  } catch (e) {
    msgs = []   // messages 还没建（没人留过言）
  }
  const askers = {}
  msgs.forEach(m => {
    if (m.author === sellerOpenid) return
    if (!askers[m.target_id]) askers[m.target_id] = {}
    askers[m.target_id][m.author] = true
  })
  const score = it => Object.keys(askers[it._id] || {}).length
  // items 本来就是新的在前，sort 是稳定的，同分时保持新的在前
  return withPic.slice().sort((a, b) => score(b) - score(a))[0]._id
}

exports.main = async (event) => {
  // 保温调用：只是为了让容器保持活着，不该真的执行业务。
  // login 尤其危险——云函数互调拿不到 OPENID，不拦的话会往 users 表
  // 插一条 openid 为空的垃圾记录。
  if (event && event.__warmup) return { success: true, warmed: true }

  const uid = event.uid
  if (!uid) return { success: false, message: '缺少 uid' }

  let user
  try {
    const res = await db.collection('users').doc(uid)
      .field({ nickname: true, avatarUrl: true, openid: true })
      .get()
    user = res.data
  } catch (err) {
    // uid 是伪造的或用户已注销——不是异常，是正常的「查无此人」
    return { success: false, message: '用户不存在' }
  }
  if (!user || !user.openid) return { success: false, message: '用户不存在' }

  // 海报要把在售的闲置全部列出来（poster: true），其余时候每类只给 PAGE_LIMIT 条
  const keys = event.poster ? ['item'] : Object.keys(TYPES)
  const limit = event.poster ? POSTER_LIMIT : PAGE_LIMIT
  const buckets = await Promise.all(keys.map(async (key) => {
    const cfg = TYPES[key]
    try {
      const res = await db.collection(cfg.collection)
        .where({ _openid: user.openid, status: cfg.status })
        .field(cfg.field)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .get()
      return res.data
    } catch (err) {
      // 某一类拉失败不该让整个主页空掉，降级成这一类为空
      console.error('加载 ' + key + ' 失败：', err)
      return []
    }
  }))

  const result = {}
  keys.forEach((key, i) => { result[key] = buckets[i] })

  return {
    success: true,
    // 只回昵称头像，openid 留在服务端
    seller: { nickname: user.nickname || '', avatarUrl: user.avatarUrl || '' },
    buckets: result,
    // 最可能卖掉的那件闲置的 _id，转发封面和标题用
    hot_item: result.item && result.item.length ? await hottest(result.item, user.openid) : ''
  }
}
