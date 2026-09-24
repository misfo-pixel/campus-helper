// 小店设置。只给已经有店的人用——开店走的是 pages/shopcreate 那个向导。
//
// 分开是有意的：开店的人还不知道要填什么，得被引着一步步走；
// 已经开了店的人通常只想改一个字段，一张长表单比三屏向导快。
// 两边共用的图片上传、方案校验在 utils/shopForm.js。

const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')
const { TEAM_MODULE_ENABLED, ORDERING_ENABLED } = require('../../config.js')
const {
  uploadShopImage, validatePlan, normalizeMode, markTeams
} = require('../../utils/shopForm.js')

Page({
  data: {
    // 黄页模式下这张表只剩「店是什么 + 怎么联系」：配送、起送价、
    // 下单补充说明全都依附于订单，订单没了它们就是在问废话。
    ordering: ORDERING_ENABLED,
    loading: true,
    saving: false,

    name: '',
    logo: '',          // 已保存的云文件 ID，或本次新选的本地临时路径
    tempLogo: '',      // 本次新选的本地文件，提交时才上传
    description: '',
    min_order: '',
    business_hours: '',
    contact_wechat: '',

    // 收款方式展示位。默认关，平台不主动把人往站外支付上引。
    noteRequired: false,
    note_hint: '',

    // 有没有线下交付。关掉的是纯线上服务，云函数会把地点和场次清空
    //（见 shopManage 的 pickShopFields）。到店自提不关这个开关——
    // 自提照样要地点和时间，只是配送费填 0。
    needsDelivery: true,

    teamEnabled: TEAM_MODULE_ENABLED,

    // 两层：先 exactAddress（送上门 or 买家自取），再 deliveryMode（谁送）。
    // 自取时 deliveryMode 没有意义，界面上整段不出现。
    exactAddress: false,
    deliveryMode: 'self',     // self 我自己送 / team 找配送队
    flat_delivery_fee: '',

    // 绑定哪一支配送队。以前「找配送队」只是个标记，具体哪支是在
    // 「配送状态」页每次发请求时现挑的；现在绑定关系落到店铺上，
    // 送达前该通知谁才有答案。
    deliveryTeamId: '',
    teams: [],
    teamsError: false,
    // 送达时间没有一支队能接（且自己也没绑过）时，「找配送队」置灰
    teamPickDisabled: false,
    teamPickReason: '',
    teamWarn: '',

    // 资质：凭证选填。平台不核实，传了就在小店页店名旁挂「证」标公开展示，不传也能开店——
    // 店长多是学生，硬卡一道「我已取得资质」的声明只会把人挡在门外。
    licenseImage: '',
    tempLicense: '',

    // 自送时才用：这家店自己的服务地点和批次
    planPoints: [],
    planBatches: []
  },

  onLoad: function () {
    this.loadShop()
    if (TEAM_MODULE_ENABLED) this.loadTeams()
  },

  // 队伍列表和店铺资料互不依赖，各读各的，谁先回来谁先渲染。
  // 队伍读失败不该把整个设置页拦下来——店长可能只是来改个营业时间。
  loadTeams: function () {
    wx.cloud.callFunction({
      name: 'deliveryManage',
      data: { action: 'listTeams' }
    }).then(res => {
      const r = (res && res.result) || {}
      if (!r.success) {
        this.setData({ teamsError: true }, () => this.refreshTeamPick())
        return
      }
      this.setData({ teams: r.teams || [], teamsError: false }, () => this.refreshTeamPick())
    }).catch(err => {
      console.error('读取配送队失败：', err)
      this.setData({ teamsError: true }, () => this.refreshTeamPick())
    })
  },

  // 哪些队现在能选，以及「找配送队」这一项要不要置灰。
  //
  // 判断按「送达时刻前后各半小时这一整段，落不落在队伍填的可配送时段里」，
  // 规则在 utils/shopForm.js 的 markTeams 里，和开店向导共用一份。队伍那边
  // 已经没有打烊开关了——时段填了就是接，不填就是不接。
  //
  // 关键的一条：已经绑定的那支队，即使时间对不上也必须可选、必须显示。
  // 服务端不过滤、这里也不过滤——否则店长打开设置页会发现自己绑的队
  // 凭空消失，以为绑定丢了，然后重新选一支，把好好的配置改坏。
  // 对不上的时候改成一句警告（teamWarn），要不要动它由他决定。
  refreshTeamPick: function () {
    const marked = markTeams(this.data.teams, this.data.planBatches, this.data.deliveryTeamId)
    this.setData({
      teams: marked.teams,
      // 读失败时不置灰：那是「不知道有没有队」，不是「没有队」。
      // 置灰会让店长以为平台上一支队都没有，而事实只是这一次没读到。
      teamPickDisabled: !this.data.teamsError && marked.disabled,
      teamPickReason: marked.reason,
      teamWarn: this.data.teamsError ? '' : marked.warn
    })
  },

  loadShop: function () {
    return wx.cloud.callFunction({ name: 'shopManage', data: { action: 'getMine' } }).then(res => {
      const r = (res && res.result) || {}

      // 读失败时 r.shop 同样是 undefined。不判 success 的话，一次网络抖动
      // 会把一个开着店的店长踢进开店向导，让他以为店没了。
      if (!r.success) {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '读取失败', icon: 'none' })
        return
      }

      const shop = r.shop

      // 没店的人不该站在设置页上，直接送去开店向导
      if (!shop) {
        wx.redirectTo({ url: '/pages/shopcreate/shopcreate' })
        return
      }

      this.setData({
        loading: false,
        name: shop.name || '',
        logo: shop.logo || '',
        description: shop.description || '',
        min_order: shop.min_order === 0 ? '0' : String(shop.min_order || ''),
        business_hours: shop.business_hours || '',
        contact_wechat: shop.contact_wechat || '',
        noteRequired: shop.note_required === true,
        note_hint: shop.note_hint || '',
        // 老店铺没这个字段，按「有线下交付」算，跟云函数那边的默认一致
        needsDelivery: shop.needs_delivery !== false,
        exactAddress: shop.exact_address === true,
        deliveryMode: normalizeMode(shop.delivery_mode),
        flat_delivery_fee: shop.flat_delivery_fee ? String(shop.flat_delivery_fee) : '',
        licenseImage: shop.license_image || '',
        deliveryTeamId: shop.delivery_team_id || '',
        planPoints: shop.pickup_points || [],
        planBatches: shop.batches || []
      }, () => this.refreshTeamPick())
    }).catch(err => {
      console.error('读取小店失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  // 服务时间和服务地点现在是两个 plan-editor 实例（排在「送到哪里」
  // 分段按钮的两侧），各只抛自己那一半，所以这里按 key 合并，不能整个覆盖。
  //
  // 改了服务时间要重算队伍可选性：能不能找配送队完全跟着送达时间走。
  onPlanChange: function (e) {
    const d = e.detail || {}
    const patch = {}
    if (d.points) patch.planPoints = d.points
    if (d.batches) patch.planBatches = d.batches
    if (!Object.keys(patch).length) return
    this.setData(patch, () => {
      if (d.batches) this.refreshTeamPick()
    })
  },

  onNoteRequiredChange: function (e) {
    this.setData({ noteRequired: e.detail.value })
  },

  onNeedsDeliveryChange: function (e) {
    this.setData({ needsDelivery: e.detail.value })
  },

  // 送到买家地址 / 送到模糊地址，分段按钮二选一
  pickExactAddress: function (e) {
    this.setData({ exactAddress: e.currentTarget.dataset.exact === '1' })
  },

  pickMode: function (e) {
    const mode = e.currentTarget.dataset.mode

    // 置灰的项点了只解释，不改状态。做成 toast 而不是干脆不响应，
    // 是因为「点了没反应」比「告诉你为什么」更让人困惑
    if (mode === 'team' && this.data.teamPickDisabled) {
      wx.showToast({ title: this.data.teamPickReason, icon: 'none' })
      return
    }

    this.setData({ deliveryMode: mode })

    // 切到配送队但一支都没选中时，自动选上唯一可选的那支。
    // 只有一支队的时候（现阶段大概率如此）省掉一次多余的点击
    if (mode === 'team' && !this.data.deliveryTeamId) {
      const usable = (this.data.teams || []).filter(t => t.selectable)
      if (usable.length === 1) this.setData({ deliveryTeamId: usable[0]._id }, () => this.refreshTeamPick())
    }
  },

  pickTeam: function (e) {
    const { id, selectable } = e.currentTarget.dataset
    if (!selectable) {
      wx.showToast({ title: '这支队在送达前后半小时里没空', icon: 'none' })
      return
    }
    this.setData({ deliveryTeamId: id }, () => this.refreshTeamPick())
  },

  onInput: function (e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  chooseLogo: function () {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ logo: path, tempLogo: path })
      }
    })
  },

  chooseLicense: function () {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ licenseImage: path, tempLicense: path })
      }
    })
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    // 漏填时指名道姓，而不是甩一句「请填完必填项」让店长自己回去找
    if (!d.name) {
      wx.showToast({ title: '请填写小店名称', icon: 'none' })
      return
    }
    if (!d.contact_wechat) {
      wx.showToast({ title: '请填写联系微信', icon: 'none' })
      return
    }
    if (d.needsDelivery) {
      const bad = validatePlan(d.planPoints, d.planBatches, d.exactAddress)
      if (bad) {
        wx.showToast({ title: bad, icon: 'none' })
        return
      }
      // 云函数那边也拦一道，这里先拦是为了不让店长白等一个来回
      if (d.exactAddress && d.deliveryMode === 'team' && !d.deliveryTeamId) {
        wx.showToast({ title: '请选择一支配送队', icon: 'none' })
        return
      }
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      // 小店资料是公开展示的内容，一样要过内容安全检测
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.business_hours, d.contact_wechat, d.note_hint]
      }))) return

      const logo = await uploadShopImage(d.tempLogo, d.logo, 'shops')
      const licenseImage = await uploadShopImage(d.tempLicense, d.licenseImage, 'licenses')
      // 换了新 Logo 才需要检测，没换的是之前已经检过的
      if (d.tempLogo && logo) {
        if (!(await ensureContentOk({ fileIDs: [logo] }))) {
          await deleteCloudFiles([logo])
          return
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'shopManage',
        data: {
          action: 'update',
          name: d.name,
          logo: logo,
          description: d.description,
          min_order: d.min_order,
          business_hours: d.business_hours,
          contact_wechat: d.contact_wechat,
          note_required: d.noteRequired,
          note_hint: d.noteRequired ? d.note_hint : '',
          needs_delivery: d.needsDelivery,
          exact_address: d.exactAddress,
          delivery_mode: d.deliveryMode,
          delivery_team_id: d.deliveryTeamId,
          flat_delivery_fee: d.flat_delivery_fee,
          license_image: licenseImage,
          pickup_points: d.planPoints,
          batches: d.planBatches
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }

      // 营业中改了服务时间 = 开了新的一场。打烊中保存的话服务端直接跳过，
      // 等店长在工作台挂上营业中时再发。
      // 开团提醒：通知订阅了这家店的买家。不等结果——服务端自己判断
      // 是不是新的一场，同一场只发一次，所以这里多调几次也不会重复打扰人。
      wx.cloud.callFunction({ name: 'shopSubscribe', data: { action: 'announce' } })
        .catch(err => console.warn('开团提醒触发失败：', err))

      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1000)
    } catch (err) {
      wx.hideLoading()
      console.error('保存小店失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  openAgreement: function () {
    wx.navigateTo({ url: '/pages/shopagreement/shopagreement' })
  }
})
