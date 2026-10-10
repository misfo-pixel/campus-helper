const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 送上门的楼栋名单（集合 delivery_buildings）。
//
// 2026-10-10 加的：「送到买家地址」原来是一个随便写的文本框，写什么都行。
// 现在只能从这份名单里挑楼，再填房间号——范围是明大 Minneapolis 校区
// （East Bank + West Bank）的楼，和周边大约 1 mile 内的公寓。St Paul 校区不算。
//
// 不用定位算距离：微信的选点用腾讯地图，明尼苏达这边数据很不全；读位置还要
// 在后台声明隐私信息，审核多一轮；「1 mile」从哪儿算也说不清。名单还有个
// 附带的好处：楼名统一了，配送队一眼看得出哪几单在同一栋。
//
// 文档：{ name, area, kind: 'campus' | 'dorm' | 'apartment', order, active }
// 名单找不到的楼不给「其他」手填口子，否则限定形同虚设——让买家走意见反馈，
// 管理员在「我的 → 配送楼栋」里加。

const AREAS = ['East Bank', 'West Bank', 'Dinkytown', 'Marcy-Holmes', 'Stadium Village', 'Prospect Park', 'Cedar-Riverside']

// 初始名单。凭记忆列的，上线前要有熟悉的人过一遍：
//   active: true  比较确定在范围内、名字也对的
//   active: false 不太确定（名字、位置或者是否超出 1 mile），先停用，核实后在管理页打开
const SEED = [
  // ---- East Bank：教学楼 / 场馆 ----
  ['East Bank', 'campus', 'Coffman Memorial Union'],
  ['East Bank', 'campus', 'Walter Library'],
  ['East Bank', 'campus', 'Northrop'],
  ['East Bank', 'campus', 'Bruininks Hall'],
  ['East Bank', 'campus', 'Keller Hall'],
  ['East Bank', 'campus', 'Tate Hall'],
  ['East Bank', 'campus', 'Smith Hall'],
  ['East Bank', 'campus', 'Kolthoff Hall'],
  ['East Bank', 'campus', 'Amundson Hall'],
  ['East Bank', 'campus', 'Lind Hall'],
  ['East Bank', 'campus', 'Mechanical Engineering'],
  ['East Bank', 'campus', 'Physics and Nanotechnology Building'],
  ['East Bank', 'campus', 'Rapson Hall'],
  ['East Bank', 'campus', 'Ford Hall'],
  ['East Bank', 'campus', 'Vincent Hall'],
  ['East Bank', 'campus', 'Murphy Hall'],
  ['East Bank', 'campus', 'Morrill Hall'],
  ['East Bank', 'campus', 'Johnston Hall'],
  ['East Bank', 'campus', 'Folwell Hall'],
  ['East Bank', 'campus', 'Jones Hall'],
  ['East Bank', 'campus', 'Nicholson Hall'],
  ['East Bank', 'campus', 'Appleby Hall'],
  ['East Bank', 'campus', 'Pillsbury Hall'],
  ['East Bank', 'campus', 'Elliott Hall'],
  ['East Bank', 'campus', 'Peik Hall'],
  ['East Bank', 'campus', 'Burton Hall'],
  ['East Bank', 'campus', 'Science Teaching and Student Services'],
  ['East Bank', 'campus', 'Moos Tower'],
  ['East Bank', 'campus', 'Mayo Memorial Building'],
  ['East Bank', 'campus', 'Phillips-Wangensteen Building'],
  ['East Bank', 'campus', 'Molecular and Cellular Biology Building'],
  ['East Bank', 'campus', 'Weisman Art Museum'],
  ['East Bank', 'campus', 'Recreation and Wellness Center'],
  ['East Bank', 'campus', 'McNamara Alumni Center'],
  ['East Bank', 'campus', 'Williams Arena'],
  ['East Bank', 'campus', 'Huntington Bank Stadium'],
  // ---- East Bank：宿舍 ----
  ['East Bank', 'dorm', 'Centennial Hall'],
  ['East Bank', 'dorm', 'Comstock Hall'],
  ['East Bank', 'dorm', 'Frontier Hall'],
  ['East Bank', 'dorm', 'Pioneer Hall'],
  ['East Bank', 'dorm', 'Sanford Hall'],
  ['East Bank', 'dorm', 'Territorial Hall'],
  ['East Bank', 'dorm', '17th Avenue Hall'],
  ['East Bank', 'dorm', 'Yudof Hall'],
  ['East Bank', 'dorm', 'Roy Wilkins Hall', false],
  // ---- West Bank ----
  ['West Bank', 'campus', 'Carlson School of Management'],
  ['West Bank', 'campus', 'Hanson Hall'],
  ['West Bank', 'campus', 'Wilson Library'],
  ['West Bank', 'campus', 'Anderson Hall'],
  ['West Bank', 'campus', 'Blegen Hall'],
  ['West Bank', 'campus', 'Social Sciences Building'],
  ['West Bank', 'campus', 'Rarig Center'],
  ['West Bank', 'campus', 'Ferguson Hall'],
  ['West Bank', 'campus', 'Mondale Hall'],
  ['West Bank', 'campus', 'Humphrey School of Public Affairs'],
  ['West Bank', 'dorm', 'Middlebrook Hall'],
  // ---- 周边公寓 ----
  ['Stadium Village', 'apartment', 'Radius at 15th'],
  ['Stadium Village', 'apartment', 'WaHu Student Apartments'],
  ['Stadium Village', 'apartment', 'The Station on Washington'],
  ['Stadium Village', 'apartment', 'Stadium Village Flats'],
  ['Stadium Village', 'apartment', 'Fieldhouse Apartments'],
  ['Stadium Village', 'apartment', 'University Village'],
  ['Stadium Village', 'apartment', 'Prime Place', false],
  ['Stadium Village', 'apartment', '700 on Washington', false],
  ['Dinkytown', 'apartment', 'The Bridges'],
  ['Dinkytown', 'apartment', 'Identity Dinkytown'],
  ['Dinkytown', 'apartment', 'The Marshall'],
  ['Dinkytown', 'apartment', 'Hub Minneapolis'],
  ['Dinkytown', 'apartment', 'Sydney Hall', false],
  ['Dinkytown', 'apartment', 'Six10 University', false],
  ['Marcy-Holmes', 'apartment', 'Keeler Apartments', false],
  ['Prospect Park', 'apartment', 'Como Student Community', false]
]

async function isAdmin(openid) {
  const me = await db.collection('users').where({ openid: openid }).limit(1).get()
  const roles = (me.data[0] && me.data[0].roles) || []
  return roles.includes('super_admin') || roles.includes('ops_admin')
}

function cleanName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60)
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  const coll = db.collection('delivery_buildings')

  try {
    switch (event.action) {

      // 买家选楼用，只给启用的
      case 'list': {
        const res = await coll.where({ active: true }).limit(1000).get()
        return {
          success: true,
          areas: AREAS,
          buildings: res.data.map(b => ({ _id: b._id, name: b.name, area: b.area, kind: b.kind, order: b.order || 0 }))
        }
      }

      // ---- 以下管理员 ----

      case 'adminList': {
        if (!(await isAdmin(openid))) return { success: false, message: '没有权限' }
        const res = await coll.limit(1000).get()
        return { success: true, areas: AREAS, buildings: res.data }
      }

      // 集合是空的时候，一键导入上面的初始名单
      case 'seed': {
        if (!(await isAdmin(openid))) return { success: false, message: '没有权限' }
        const count = await coll.count()
        if (count.total > 0) return { success: false, message: '名单里已经有楼了' }
        await Promise.all(SEED.map((row, i) => coll.add({
          data: {
            area: row[0],
            kind: row[1],
            name: row[2],
            active: row[3] !== false,
            order: i,
            created_at: new Date()
          }
        })))
        return { success: true, count: SEED.length }
      }

      case 'add': {
        if (!(await isAdmin(openid))) return { success: false, message: '没有权限' }
        const name = cleanName(event.name)
        if (!name) return { success: false, message: '请填写楼名' }
        if (AREAS.indexOf(event.area) < 0) return { success: false, message: '请选择片区' }
        const dup = await coll.where({ name: name }).count()
        if (dup.total > 0) return { success: false, message: '这栋楼已经在名单里了' }
        await coll.add({
          data: {
            name: name,
            area: event.area,
            kind: event.kind === 'campus' || event.kind === 'dorm' ? event.kind : 'apartment',
            active: true,
            order: Date.now(),   // 新加的排在同片区最后
            created_at: new Date()
          }
        })
        return { success: true }
      }

      // 改名 / 启用停用。不提供删除：历史订单里存的是楼名快照，删了不影响，
      // 但停用就够了，误删了还得重新录
      case 'update': {
        if (!(await isAdmin(openid))) return { success: false, message: '没有权限' }
        if (!event.id) return { success: false, message: '参数不完整' }
        const data = { updated_at: new Date() }
        if (event.name !== undefined) {
          const name = cleanName(event.name)
          if (!name) return { success: false, message: '请填写楼名' }
          data.name = name
        }
        if (event.active !== undefined) data.active = event.active === true
        await coll.doc(event.id).update({ data: data })
        return { success: true }
      }

      default:
        return { success: false, message: '未知操作：' + event.action }
    }
  } catch (err) {
    console.error('buildings 失败：', event.action, err)
    const text = String((err && (err.errMsg || err.message)) || '')
    if (/collection not exists|COLLECTION_NOT_EXIST|-502005/i.test(text)) {
      return { success: false, message: '数据库未初始化，请联系管理员' }
    }
    return { success: false, message: '操作失败，请重试' }
  }
}
