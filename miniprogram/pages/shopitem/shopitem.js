// 菜品编辑。带 id 进来是改，不带是加。
const { ensureContentOk, deleteCloudFiles } = require('../../utils/contentCheck.js')

Page({
  data: {
    itemId: '',
    isNew: true,
    loading: false,
    saving: false,

    name: '',
    price: '',
    description: '',
    allergens: '',
    category: '',
    image: '',
    tempImage: '',
    available: true
  },

  onLoad: function (options) {
    if (!options.id) {
      wx.setNavigationBarTitle({ title: '添加菜品' })
      return
    }

    this.setData({ itemId: options.id, isNew: false, loading: true })
    wx.setNavigationBarTitle({ title: '编辑菜品' })

    // 菜品数量不多，直接复用列表接口挑出这一条，不用再加一个云函数 action
    wx.cloud.callFunction({ name: 'shopManage', data: { action: 'listItems' } }).then(res => {
      const r = (res && res.result) || {}
      const item = (r.items || []).find(i => i._id === options.id)
      if (!item) {
        this.setData({ loading: false })
        wx.showToast({ title: '菜品不存在', icon: 'none' })
        return
      }
      this.setData({
        loading: false,
        name: item.name || '',
        price: String(item.price),
        description: item.description || '',
        allergens: item.allergens || '',
        category: item.category || '',
        image: item.image || '',
        available: item.available !== false
      })
    }).catch(err => {
      console.error('读取菜品失败：', err)
      this.setData({ loading: false })
      wx.showToast({ title: '读取失败', icon: 'none' })
    })
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onAvailableChange: function (e) {
    this.setData({ available: e.detail.value })
  },

  chooseImage: function () {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ image: path, tempImage: path })
      }
    })
  },

  uploadImage: function () {
    const temp = this.data.tempImage
    if (!temp) return Promise.resolve(this.data.image)

    const match = temp.match(/\.(\w+)$/)
    const ext = match ? match[1] : 'jpg'
    const cloudPath = 'dishes/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
    return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: temp }).then(r => r.fileID)
  },

  submit: async function () {
    const d = this.data
    if (d.saving) return

    if (!d.name) {
      wx.showToast({ title: '请填写菜品名称', icon: 'none' })
      return
    }
    if (d.price === '' || !(Number(d.price) >= 0)) {
      wx.showToast({ title: '请填写正确的价格', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      if (!(await ensureContentOk({
        texts: [d.name, d.description, d.allergens, d.category]
      }))) return

      const image = await this.uploadImage()

      if (d.tempImage && image) {
        if (!(await ensureContentOk({ fileIDs: [image] }))) {
          await deleteCloudFiles([image])
          return
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'shopManage',
        data: {
          action: 'saveItem',
          itemId: d.itemId || undefined,
          name: d.name,
          price: d.price,
          description: d.description,
          allergens: d.allergens,
          category: d.category,
          image: image,
          available: d.available
        }
      })

      wx.hideLoading()
      const r = (res && res.result) || {}
      if (r.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 800)
      } else {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('保存菜品失败：', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  }
})
