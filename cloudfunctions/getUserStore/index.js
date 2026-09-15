// 用户公开主页的数据源。
//
// 为什么必须走云函数：主页链接会被转发给陌生人，链接里只能带一个不透明的编号
// （users 文档的随机 _id），不能带 openid——openid 是永久身份标识，散出去等于
// 给了别人一个永久追踪句柄。openid 只在这里、服务端内部使用，不下发给前端。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE_LIMIT = 20

// 三种业务的差异收敛在这里，加板块只加一行
const TYPES = {
  item: {
    collection: 'secondhand_items',
    status: 'on_sale',
    field: { title: true, price: true, images: true, kind: true }
  },
  sublet: {
    collection: 'sublet_items',
    status: 'on_sale',
    field: { title: true, rent: true, images: true, room_type: true, address: true, kind: true }
  },
  task: {
    collection: 'task_items',
    status: 'open',      // 注意任务用的是 open，不是 on_sale
    field: { title: true, reward: true, images: true, deadline: true }
  }
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

  const keys = Object.keys(TYPES)
  const buckets = await Promise.all(keys.map(async (key) => {
    const cfg = TYPES[key]
    try {
      const res = await db.collection(cfg.collection)
        .where({ _openid: user.openid, status: cfg.status })
        .field(cfg.field)
        .orderBy('created_at', 'desc')
        .limit(PAGE_LIMIT)
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
    buckets: result
  }
}
