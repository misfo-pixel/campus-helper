const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 生活百科的种子数据：分类 + 5 条示例词条。仅管理员可跑，可重复跑（按 title 去重）。
//
// 内容原则（见开发计划）：
//   - 不编造具体数字、地址、营业时间；不确定的写「待核实」
//   - 来源优先学校 / 政府官方页面
//   - 示例里 3 条 verified（能直接看到效果）、2 条 draft（演示「草稿对外不可见」），
//     正式内容逐条人工核实后再把 draft 改成 verified

const CATEGORIES = [
  { name: '刚到明尼', icon: '🛬', order: 1 },
  { name: '交通出行', icon: '🚌', order: 2 },
  { name: '吃穿住行', icon: '🏠', order: 3 },
  { name: '学校事务', icon: '🎓', order: 4 },
  { name: '医疗保险', icon: '🏥', order: 5 },
  { name: '报税与身份', icon: '📄', order: 6 }
]

// category 用分类名引用，导入时换成 _id
const ARTICLES = [
  {
    title: '新生落地第一周要做的事',
    category: '刚到明尼',
    summary: '报到、银行卡、电话卡、公交卡，按顺序来最省事。',
    tags: ['新生', '入境', 'check-in'],
    applicableTo: ['新生', 'F-1'],
    content: [
      '## 先办学校的事',
      '',
      '- 到校后尽快完成 ISSS 的入境报到（check-in），F-1 身份激活以它为准',
      '- 领 U Card（学生证），坐公交、进图书馆都要用',
      '',
      '## 再办生活的事',
      '',
      '- **电话卡**：各大运营商门店或网上办理，记得带护照',
      '- **银行卡**：学校周边有多家银行可选，开户所需材料以银行官网为准',
      '- **公交**：UMN 学生可办理学生公交卡，具体优惠以 Metro Transit 官网为准',
      '',
      '> 具体截止日期和所需材料每年可能调整，以 ISSS 和学校官网通知为准。'
    ].join('\n'),
    sources: [
      { title: 'UMN ISSS（国际学生学者办公室）', url: 'https://isss.umn.edu/' },
      { title: 'Metro Transit 学生优惠', url: 'https://www.metrotransit.org/' }
    ],
    status: 'verified'
  },
  {
    title: '没有车怎么出门：公交和轻轨',
    category: '交通出行',
    summary: '校园在蓝线/绿线沿线，公交卡是学生最常用的出行方式。',
    tags: ['公交', '轻轨', '出行'],
    applicableTo: ['新生', '在校生'],
    content: [
      '## 校园周边的交通',
      '',
      '- 双城校区东西两岸之间有校园摆渡车（Campus Connector），凭 U Card 免费',
      '- 轻轨绿线连接明尼阿波利斯和圣保罗两个市中心，经过校园',
      '- 用 Metro Transit 官网或地图 App 查线路和时刻',
      '',
      '## 冬天通勤',
      '',
      '- 教学楼之间有地下通道（Gopher Way）相连，冬天可以少出室外',
      '',
      '> 票价和学生优惠会调整，以 Metro Transit 官网为准。'
    ].join('\n'),
    sources: [
      { title: 'Metro Transit', url: 'https://www.metrotransit.org/' },
      { title: 'UMN 停车与交通服务', url: 'https://pts.umn.edu/' }
    ],
    status: 'verified'
  },
  {
    title: 'F-1 学生报税：从哪里开始',
    category: '报税与身份',
    summary: 'F-1 即使没有收入也通常需要提交 Form 8843，具体以 IRS 和学校指导为准。',
    tags: ['报税', 'F-1', '8843'],
    applicableTo: ['F-1'],
    disclaimer: true,
    content: [
      '## 先说清楚',
      '',
      '这条只整理官方信息，不构成税务建议。个人情况不同，请以 IRS 原文和 ISSS 的说明为准。',
      '',
      '## 官方渠道',
      '',
      '- IRS 官网有针对非居民外国人（Nonresident Alien）的说明页面',
      '- ISSS 每年春季会提供报税指导和软件（如 Sprintax）的使用信息',
      '',
      '## 常见要点（转述自官方说明）',
      '',
      '- 没有美国收入的 F-1 学生通常仍需提交 Form 8843',
      '- 有工资收入的按非居民身份报税，表格和截止日期以 IRS 当年公告为准'
    ].join('\n'),
    sources: [
      { title: 'IRS（美国国税局）', url: 'https://www.irs.gov/' },
      { title: 'UMN ISSS 税务信息', url: 'https://isss.umn.edu/' }
    ],
    status: 'verified'
  },
  {
    title: '学校医疗保险（SHB）怎么 waiver',
    category: '医疗保险',
    summary: '有符合要求的校外保险可以申请免掉学校保险，截止日期每学期不同。',
    tags: ['保险', 'waiver', 'SHB'],
    applicableTo: ['新生', '在校生'],
    content: [
      '## 待核实',
      '',
      '本条为示例草稿：waiver 的具体要求、截止日期和流程以学校 Student Health Benefits 官网当季公告为准。',
      '',
      '核实后请补充：',
      '',
      '- 申请 waiver 的入口和截止日期',
      '- 校外保险需要满足的最低条件'
    ].join('\n'),
    sources: [
      { title: 'UMN Student Health Benefits', url: 'https://shb.umn.edu/' }
    ],
    status: 'draft'
  },
  {
    title: '考明尼苏达驾照 / 办 State ID',
    category: '交通出行',
    summary: '不买车也建议办一张 State ID，买菜坐飞机都用得上。',
    tags: ['驾照', 'State ID', 'DVS'],
    applicableTo: ['新生', '在校生'],
    content: [
      '## 待核实',
      '',
      '本条为示例草稿：所需材料、费用和预约方式以明尼苏达 DVS 官网为准。',
      '',
      '核实后请补充：',
      '',
      '- 笔试 / 路考的预约流程',
      '- State ID 和驾照分别需要带哪些证件'
    ].join('\n'),
    sources: [
      { title: 'Minnesota DVS（车管局）', url: 'https://dps.mn.gov/divisions/dvs/' }
    ],
    status: 'draft'
  }
]

exports.main = async (event) => {
  if (event && event.__warmup) return { success: true, warmed: true }

  const openid = cloud.getWXContext().OPENID
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  const roles = (me.data[0] && me.data[0].roles) || []
  if (!roles.includes('super_admin') && !roles.includes('market_admin')) {
    return { success: false, message: '没有权限' }
  }

  try {
    // 分类：按 name 去重
    const catIds = {}
    for (const c of CATEGORIES) {
      const exist = await db.collection('wiki_categories').where({ name: c.name }).limit(1).get()
      if (exist.data.length) {
        catIds[c.name] = exist.data[0]._id
      } else {
        const added = await db.collection('wiki_categories').add({ data: c })
        catIds[c.name] = added._id
      }
    }

    // 词条：按 title 去重
    let addedCount = 0
    for (const a of ARTICLES) {
      const exist = await db.collection('wiki_articles').where({ title: a.title }).limit(1).get()
      if (exist.data.length) continue
      const now = new Date()
      await db.collection('wiki_articles').add({
        data: {
          title: a.title,
          categoryId: catIds[a.category],
          summary: a.summary,
          content: a.content,
          tags: a.tags,
          applicableTo: a.applicableTo,
          sources: a.sources,
          disclaimer: !!a.disclaimer,
          status: a.status,
          verifiedAt: a.status === 'verified' ? now : null,
          updatedAt: now,
          viewCount: 0,
          helpfulCount: 0,
          outdatedCount: 0
        }
      })
      addedCount++
    }

    return { success: true, message: `导入完成，新增 ${addedCount} 条词条` }
  } catch (err) {
    console.error('wikiSeed 失败：', err)
    return { success: false, message: '导入失败' }
  }
}
