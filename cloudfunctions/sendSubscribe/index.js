const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 发订阅消息。
//
// 调用方只传【语义字段】（谁下的单、买了什么、多少钱…），不碰 thing1/amount2
// 这套微信的字段名——那套映射只活在下面的 TEMPLATES 里。
// 好处：以后字段名对不上，改这一个文件就行，不用去五个触发点里翻。
//
// 字段名（thing14 / short_thing6 / amount4 …）是从小程序后台
// 「订阅消息 → 我的模板 → 详情」照抄的。编号不是 1、2、3 顺排——
// 那是公共模板库里每个关键词自己的编号，猜不出来，只能抄。
// 换模板或改关键词之后记得回来重抄一遍。
//
// 另外两条微信的硬规矩：
//   - 一次授权只能发一条，发完这张票就没了
//   - 字段有长度限制：thing 20 个字符以内，phrase 5 个汉字以内，超了直接报错

const TEMPLATES = {
  // 新订单通知 —— 发给店长。小店新单和委托接单共用这一个模板，
  // 所以字段挑的都是两种场景都成立的词（没选「商品总数」那类）。
  newOrder: {
    id: 'aP1AnsfSnR83eOZdVtMJh6Q0lrO0OuiWzwHEcbzP418',
    fields: {
      buyer: 'thing14',       // 下单人
      orderType: 'thing27',   // 订单类型（小店订单 / 委托）
      content: 'thing41',     // 订单内容
      amount: 'amount4',      // 金额
      time: 'time9'           // 下单时间
    }
  },

  // 订单进度通知 —— 发给买家
  orderProgress: {
    id: 'K7gsdZYeDJ-0npxB2n28WX8uCr47wChrIwnQRDR9_cQ',
    fields: {
      status: 'phrase2',      // 当前状态（5 个以内汉字）
      item: 'thing6',         // 商品名称
      time: 'date3',          // 操作时间 —— 后台给的是 date 不是 time
      tip: 'thing16'          // 提醒事项
    }
  },

  // 服务咨询提醒 —— 发给发帖人
  inquiry: {
    id: 'e0y61cAJe_oAQaexZDJgVqh0gasrQ-O24bWDaR_Srm4',
    fields: {
      who: 'thing8',          // 咨询人
      kind: 'short_thing6',   // 咨询类型（5 个以内字符，正好放「二手/转租/委托」）
      content: 'thing2',      // 咨询内容
      time: 'time3'           // 通知时间
    }
  },

  // 举报结果通知 —— 发给举报人
  reportResult: {
    id: 'o49G1HUUs-48xmMCuHBgXCOjmBF8Okm6FRzjxrbPQbI',
    fields: {
      content: 'thing2',      // 举报内容
      result: 'thing5',       // 审核结果 —— 是 thing 不是 phrase，没有 5 字限制
      date: 'time10',         // 处理日期 —— 是 time 不是 date，要带时分
      tip: 'thing8'           // 温馨提示
    }
  },

  // 反馈回复通知 —— 发给提反馈的人
  feedbackReply: {
    id: '9_5xmst_f3GF0aRB9L5vXi2udFxtr08SJURAH5MnVEM',
    fields: {
      reply: 'thing5',        // 回复内容
      kind: 'thing3',         // 反馈类型
      time: 'time6'           // 回复时间
    }
  },

  // 待处理提醒 —— 每天汇总一条发给管理员（adminDigest 定时触发）
  adminPending: {
    id: 'xiI_4diT0eLkpS6cVSS6KwyVPTQ90cNL8vJedt11d4M',
    fields: {
      count: 'number1',       // 待处理数量
      tip: 'thing3',          // 温馨提示（举报 N 条 · 反馈 N 条）
      time: 'time4'           // 提醒时间
    }
  },

  // 开团提醒 —— 发给订阅了某家店的买家（shopSubscribe 的 announce 批量发）
  //
  // 公共库里没有「开团」模板，用的是「产品截团通知」（编号 17717，类目 信息查询）。
  // 买家收到时最要紧的就是「几点截单」，截团时间正好装它；标题叫截团不叫开团，
  // 但内容说的是同一场，不冲突。
  shopOpen: {
    id: 'IaOuudvjfzb534S9XXllRBVPyFM1JCu5Fha9Yz83tOY',
    fields: {
      shop: 'thing2',         // 厂家名称 → 店铺名
      cutoff: 'time3',        // 截团时间 → 这一场的截单时刻
      tip: 'thing4'           // 产品简介 → 服务时间
    }
  },

  // 商品过期提醒 —— 发给发帖人
  expiring: {
    id: 'uWw8UB3-4awM9grpz7ovyxFSXeprAukc2JnLCzB2DEo',
    fields: {
      title: 'thing1',        // 商品名称
      kind: 'thing7',         // 类别
      expireAt: 'date3',      // 过期日期
      tip: 'thing10'          // 备注
    }
  }
}

// 各类型的长度上限。超了微信整条拒收（47003），宁可截断也别发不出去。
// 没列出来的（time / date / amount）由调用方保证格式，这里不动。
const LIMITS = {
  phrase: 5,             // 5 个以内汉字
  short_thing: 5,        // 5 个以内字符
  symbol: 5,
  thing: 20,             // 20 个以内字符
  letter: 32,
  character_string: 32
}

// thing14 → thing，short_thing6 → short_thing。
// 不能用前缀匹配：short_thing 不以 thing 开头，按前缀判会漏。
function fieldType(name) {
  return String(name).replace(/\d+$/, '')
}

function clip(value, max) {
  const s = String(value === undefined || value === null ? '' : value).trim()
  if (!s) return '—'                       // 空值也会被拒，给个占位
  if (!max || s.length <= max) return s
  return max > 1 ? s.slice(0, max - 1) + '…' : s.slice(0, max)
}

function buildData(tpl, payload) {
  const data = {}
  Object.keys(tpl.fields).forEach(key => {
    const field = tpl.fields[key]
    const type = fieldType(field)
    const raw = payload[key]

    if (type === 'number') {
      // number 只认纯数字，混进别的字符整条会被拒
      const n = Number(raw)
      data[field] = { value: String(isNaN(n) ? 0 : n) }
    } else {
      data[field] = { value: clip(raw, LIMITS[type]) }
    }
  })
  return data
}

exports.main = async (event) => {
  const tpl = TEMPLATES[event.tpl]
  if (!tpl) return { success: false, message: '未知模板：' + event.tpl }

  // 模板还没在后台申请下来。静默跳过，不要让调用方以为出了错——
  // 通知本来就是锦上添花，缺一个模板不该有任何副作用。
  if (!tpl.id) {
    console.info('模板尚未配置 ID，跳过：', event.tpl)
    return { success: false, pending: true }
  }

  // 批量：同一条内容发给一批人（开团提醒）。逐个发，并发，互不影响，
  // 返回每个人的结果——调用方要按结果扣票（成功扣一张，43101 说明没票了）。
  if (Array.isArray(event.toUsers)) {
    const results = await Promise.all(event.toUsers.map(u => sendOne(tpl, u, event)))
    return { success: true, results: results }
  }

  // 不传 toUser 就发给调用者自己。发给别人（比如买家下单后通知店长）时
  // 由调用方传对方的 openid——这个 openid 只能从数据库里查出来，
  // 不能由小程序端传进来，否则谁都能拿它给任意用户发消息。
  const toUser = event.toUser || cloud.getWXContext().OPENID
  if (!toUser) return { success: false, message: '没有接收人' }

  const r = await sendOne(tpl, toUser, event)
  return { success: r.success, errCode: r.errCode }
}

async function sendOne(tpl, toUser, event) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: toUser,
      templateId: tpl.id,
      page: event.page || 'pages/home/home',
      miniprogramState: event.state || 'formal',   // 体验版调试时传 'trial'
      lang: 'zh_CN',
      data: buildData(tpl, event.data || {})
    })
    return { toUser: toUser, success: true }
  } catch (err) {
    // 发不出去是常态，不是异常：用户没授权（43101）、票用完了、
    // 字段不合模板（47003）。一律吞掉，只留日志——通知是锦上添花，
    // 绝不能因为发不出通知就让下单、发帖这些主流程失败。
    console.warn('订阅消息发送失败：', event.tpl, err && err.errCode, err && err.errMsg)
    return { toUser: toUser, success: false, errCode: err && err.errCode }
  }
}
