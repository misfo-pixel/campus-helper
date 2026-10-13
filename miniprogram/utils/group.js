// 一起拼团的文案：进度、截单时间、转发标题。列表、店铺页、下单、参团成功、
// 我的订单、店长工作台说的是同一件事，放一处，口径才一致。
//
// 时间一律用云函数给的明尼苏达当地时间（'YYYY-MM-DD HH:MM' 字符串），
// 「今天 / 明天」也按云函数返回的 now 算，不看手机时区——人在国内看也不会差一天。
//
// 门槛按单数算，对外说「再来 N 位」：再来 N 个人各下一单就一定成团，这句话总成立。
// 但不说「已有 N 人参团」——一个人下两单，N 就对不上了。

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 'YYYY-MM-DD' 加减天数。补 T12:00:00Z 再算，避开时区把日期推过零点
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}

function weekday(date) {
  const d = new Date(date + 'T12:00:00Z')
  return isNaN(d.getTime()) ? '' : WEEK[d.getUTCDay()]
}

// '2026-10-16' → '10/16'
function md(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date || '')
  return m ? Number(m[1]) + '/' + Number(m[2]) : ''
}

// 两个 'YYYY-MM-DD HH:MM' 之间差几分钟
function minutesBetween(from, to) {
  const a = new Date(String(from).replace(' ', 'T') + ':00Z')
  const b = new Date(String(to).replace(' ', 'T') + ':00Z')
  return Math.round((b - a) / 60000)
}

// 今天 / 明天 / 后天，别的日子返回空串
function relDay(date, now) {
  const today = String(now || '').slice(0, 10)
  if (!today) return ''
  if (date === today) return '今天'
  if (date === addDays(today, 1)) return '明天'
  if (date === addDays(today, 2)) return '后天'
  return ''
}

// '2026-10-14 10:00' → '10/14 10:00'，今天明天换成字
function atText(at, now) {
  const date = String(at || '').slice(0, 10)
  const time = String(at || '').slice(11, 16)
  return (relDay(date, now) || md(date)) + ' ' + time
}

// 「明晚 22:00 截单」「还剩 2 小时截单」「周三 22:00 截单」
function cutoffText(s, now) {
  const left = s.minutes_left
  if (left != null && left < 60) return Math.max(1, left) + ' 分钟后截单'
  if (left != null && left < 180) return '还剩 ' + Math.floor(left / 60) + ' 小时截单'

  const date = String(s.cutoff_at || '').slice(0, 10)
  const time = String(s.cutoff_at || '').slice(11, 16)
  const night = Number(time.slice(0, 2)) >= 18
  const rel = relDay(date, now)
  if (rel === '今天') return (night ? '今晚 ' : '今天 ') + time + ' 截单'
  if (rel === '明天') return (night ? '明晚 ' : '明天 ') + time + ' 截单'
  return weekday(date) + ' ' + time + ' 截单'
}

// 进度条和那一句话。joined = 我已经在这一团里了（「就差你了」不对我说）
function progress(s, joined) {
  const min = Number(s.min_orders) || 0
  const count = Number(s.count) || 0
  if (!min) return { pct: 100, open: true, formed: true, gap: 0, text: '下单就送' }
  const gap = Math.max(0, min - count)
  return {
    pct: Math.min(100, Math.round(count / min * 100)),
    open: false,
    formed: gap === 0,
    gap: gap,
    text: gap === 0 ? '已成团，还能上车' : (gap === 1 && !joined ? '就差你了' : '再来 ' + gap + ' 位就开团')
  }
}

function clip(s, n) {
  const chars = Array.from(String(s || '').trim())
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('')
}

// 转发卡片标题。卡片在群里能躺到第二天，所以不写「今晚」这种会过期的词，写日期
function shareTitle(shopName, s, joined) {
  const name = clip(shopName, 10)
  const p = progress(s, joined)
  const day = md(s.date) + ' ' + weekday(s.date)
  if (p.open) return name + ' · ' + day + '送到学校'
  if (p.formed) return name + '已成团，' + day + '送到学校'
  if (joined) return '我拼了' + name + '，再来 ' + p.gap + ' 位就开团'
  if (p.gap === 1) return '只差 1 位！' + name + ' ' + day + '开团'
  return '还差 ' + p.gap + ' 位！' + name + ' ' + day + '拼团中'
}

// 店长自己转发：用他写的广告语，后面跟进度（「麻辣鲜香水煮鱼 · 还差 3 位」）。
// 没写广告语就和别人转发一样
function ownerTitle(shop, s) {
  if (!shop.slogan) return shareTitle(shop.name, s, false)
  const p = progress(s, false)
  const tail = p.open ? md(s.date) + ' ' + weekday(s.date) + '送到学校' : (p.formed ? '已成团，还能上车' : '还差 ' + p.gap + ' 位')
  return shop.slogan + ' · ' + tail
}

// 转发卡片要的数据（utils/groupCover.js 的 renderCard）。
// shop: { name, slogan, logo }；theme: 这家店的配色（components/groupShare 的 themeFor）；
// items: 店铺的商品，有图、在售的里面挑卖得最多的那道放进拍立得（sold 来自 shopBrowse），
// 都没卖过就是第一道
function cardData(shop, s, items, theme) {
  const dish = (items || [])
    .filter(i => i.available !== false && i.image)
    .reduce((best, i) => (!best || (i.sold || 0) > (best.sold || 0) ? i : best), null)
  return {
    theme: theme,
    shopName: shop.name || '',
    slogan: shop.slogan || '',
    logo: shop.logo || '',
    dishImage: dish ? dish.image : '',
    date: s.date,
    min_orders: s.min_orders || 0,
    count: s.count || 0
  }
}

// 长图海报要的数据（renderLong）：在售的菜全部列出来，店长开了分类就按分类分组
function longData(shop, s, items, theme, qrFileID) {
  const live = (items || []).filter(i => i.available !== false)
  let sections
  if (shop.use_category) {
    const order = []
    const map = {}
    live.forEach(i => {
      const c = i.category || '其他'
      if (!map[c]) {
        map[c] = []
        order.push(c)
      }
      map[c].push(i)
    })
    order.sort((a, b) => (a === '其他' ? 1 : b === '其他' ? -1 : 0))
    sections = order.map(c => ({ title: c, items: map[c] }))
  } else {
    sections = [{ title: '', items: live }]
  }
  const points = (s.points || []).map(p => p.name + ' ' + p.arrive + ' 取')
  const cut = String(s.cutoff_at || '')
  return {
    theme: theme,
    title: shop.name || '',
    subtitle: shop.slogan || '',
    logo: shop.logo || '',
    tag: s.min_orders ? '满' + s.min_orders + '单' : '下单就送',
    when: { date: s.date, time: s.depart_time },
    info: points.concat([
      s.min_orders ? '满 ' + s.min_orders + ' 单成团' : '不设门槛，下单就送',
      md(cut) + ' ' + weekday(cut.slice(0, 10)) + ' ' + cut.slice(11, 16) + ' 截单'
    ]),
    sections: sections.map(sec => ({
      title: sec.title,
      items: sec.items.map(i => ({ image: i.image || '', name: i.name, price: i.price }))
    })),
    qrFileID: qrFileID || '',
    footer: '一起拼团 · 明尼助手'
  }
}

// 一场的标题行：「10/16 周四 · 17:00 出发」
function sessionTitle(s) {
  return md(s.date) + ' ' + weekday(s.date) + ' · ' + s.depart_time + ' 出发'
}

// 取货点摘要：「Coffman 门口 17:15」，多个点再加「等 3 处」
function pointsText(points) {
  const list = points || []
  if (!list.length) return ''
  const first = list[0].name + ' ' + (list[0].arrive || '')
  return list.length > 1 ? first + ' 等 ' + list.length + ' 处' : first
}

module.exports = {
  WEEK: WEEK,
  addDays: addDays,
  weekday: weekday,
  md: md,
  minutesBetween: minutesBetween,
  relDay: relDay,
  atText: atText,
  cutoffText: cutoffText,
  progress: progress,
  shareTitle: shareTitle,
  ownerTitle: ownerTitle,
  cardData: cardData,
  longData: longData,
  sessionTitle: sessionTitle,
  pointsText: pointsText
}
