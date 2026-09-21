// 订阅消息：前端这一半只负责「要授权」。
//
// 微信的规矩有两条要先记住，不然会写出一套看着能跑、实际收不到消息的代码：
//
//   1. requestSubscribeMessage 授权的是【调用它的那个用户自己】收消息。
//      买家点一次，只是买家自己能收到；店长要收「新订单」，得店长自己
//      在工作台点一次。不存在「A 点一下让 B 收到」这回事。
//
//   2. 一次授权只能发一条。用户点「允许」= 给你一张一次性的票，发完就没了。
//      所以授权要挑在用户【正期待后续通知】的那一刻要——下单点提交时、
//      发帖点发布时——而不是一进小程序就弹。
//
// 模板 ID 在小程序后台「订阅消息」里申请。云函数那边有一份一模一样的常量，
// 云函数和小程序不共享代码，只能各存一份，改的时候两边一起改。
const TEMPLATES = {
  // 新订单通知 —— 发给店长（小店新单 / 委托接单共用）
  newOrder: 'aP1AnsfSnR83eOZdVtMJh6Q0lrO0OuiWzwHEcbzP418',
  // 订单进度通知 —— 发给买家
  orderProgress: 'K7gsdZYeDJ-0npxB2n28WX8uCr47wChrIwnQRDR9_cQ',
  // 服务咨询提醒 —— 发给发帖人（二手 / 转租 / 委托有人想要）
  inquiry: 'e0y61cAJe_oAQaexZDJgVqh0gasrQ-O24bWDaR_Srm4',
  // 商品过期提醒 —— 发给发帖人
  expiring: 'uWw8UB3-4awM9grpz7ovyxFSXeprAukc2JnLCzB2DEo',
  // 举报结果通知 —— 发给举报人
  reportResult: 'o49G1HUUs-48xmMCuHBgXCOjmBF8Okm6FRzjxrbPQbI',
  // 反馈回复通知 —— 发给提反馈的人
  feedbackReply: '9_5xmst_f3GF0aRB9L5vXi2udFxtr08SJURAH5MnVEM',
  // 待处理提醒 —— 管理员每日汇总
  adminPending: 'xiI_4diT0eLkpS6cVSS6KwyVPTQ90cNL8vJedt11d4M'
}

// 要一次授权。永远 resolve，不 reject——
// 用户拒绝、系统弹不出来、或者这台设备的基础库太老，都不该把主流程带崩：
// 下单就是下单，收不收得到通知是附加的。
function ask(names) {
  const ids = (Array.isArray(names) ? names : [names])
    .map(n => TEMPLATES[n])
    .filter(Boolean)

  if (!ids.length || !wx.requestSubscribeMessage) return Promise.resolve(false)

  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: res => {
        // 只要有一个是 accept 就算拿到票了
        resolve(ids.some(id => res[id] === 'accept'))
      },
      fail: err => {
        console.warn('订阅授权失败（不影响主流程）：', err)
        resolve(false)
      }
    })
  })
}

// ask 的加强版：给用户主动点的按钮用。
//
// 坑在这里：用户在授权弹窗里点「拒绝」并勾了「总是保持以上选择」之后，
// 再调 requestSubscribeMessage 会【直接返回 reject，连弹窗都不出】——
// 按钮看着没反应，点一百次也没用。
//
// 所以失败之后要分清两种情况：
//   只是这次没点同意  → 什么都不做，下次点按钮照样弹，不用打扰他
//   勾了「不再询问」  → 只能引导去设置里打开，这是唯一的出路
function askOrGuide(name) {
  const id = TEMPLATES[name]
  if (!id) return Promise.resolve(false)

  return ask(name).then(ok => {
    if (ok) return true

    return new Promise(resolve => {
      wx.getSetting({
        withSubscriptions: true,
        success: res => {
          const setting = res.subscriptionsSetting || {}
          const items = setting.itemSettings || {}
          const blocked = setting.mainSwitch === false || items[id] === 'reject'

          // 没被永久拒绝：下次再点按钮还会弹，这里安静退出就行
          if (!blocked) return resolve(false)

          wx.showModal({
            title: '通知已被关闭',
            content: '你之前选了「不再询问」，需要在设置里重新打开。',
            confirmText: '去设置',
            success: r => {
              if (r.confirm) wx.openSetting({ withSubscriptions: true })
              resolve(false)
            },
            fail: () => resolve(false)
          })
        },
        fail: () => resolve(false)
      })
    })
  })
}

module.exports = {
  TEMPLATES: TEMPLATES,
  ask: ask,
  askOrGuide: askOrGuide
}
