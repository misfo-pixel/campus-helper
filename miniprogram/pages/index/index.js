// index.js
Page({
  data: {
    offers: [],
    menuItems: [],
    showOrderForm: false,       // 控制下单弹层显示
    selectedItem: null,         // 当前选中的菜品
    pickupName: '',             // 用户填的取餐名
    buildingIndex: null,        // 用户选的楼栋（下拉索引）
    buildings: ['Identity Dinkytown', 'Venue at Dinkytown', 'UNCOMMON Dinkytown', 'Radius Apartments', 'The Standard at Dinkytown', '44 North', 'Stadium Village Flats', 'University Village'],
    isAdmin : false,
  },
  goToMarket: function () {
    wx.navigateTo({ url: '/pages/market/market' })
  },
  onLoad: function () {
    const db = wx.cloud.database()
    db.collection('daily_offers').get().then(res => {
      console.log('读到的数据：', res.data)
      this.setData({
        offers: res.data
      })
    }).catch(err => {
      console.error('读取失败：', err)
    })
    db.collection('menu_items').get().then(res => {
      console.log('读到的菜品：', res.data)
      this.setData({
        menuItems: res.data
      })
    }).catch(err => {
      console.error('读菜品失败：', err)
    })

    // 读取全局角色，判断是否管理员
    const app = getApp()
    // 稍等一下确保 login 完成（简单处理）
    // 判断是否管理员：直接调 login 云函数拿最新角色
    // 判断是否有外卖管理权限
    wx.cloud.callFunction({ name: 'login' }).then(res => {
      if (res.result.success) {
        const roles = res.result.roles || []
        this.setData({
          isAdmin: roles.includes('food_admin') || roles.includes('super_admin')
        })
      }
    })
  },
  // 点菜品的"下单"，弹出表单
  openOrderForm: function (e) {
    this.setData({
      showOrderForm: true,
      selectedItem: e.currentTarget.dataset.item,
      pickupName: '',
      buildingIndex: null
    })
  },

  // 关闭表单
  closeOrderForm: function () {
    this.setData({ showOrderForm: false })
  },

  // 输入取餐名
  onPickupNameInput: function (e) {
    this.setData({ pickupName: e.detail.value })
  },

  // 选择楼栋
  onBuildingChange: function (e) {
    this.setData({ buildingIndex: e.detail.value })
  },

  // 确认下单
  submitOrder: function () {
    const item = this.data.selectedItem
    const pickupName = this.data.pickupName
    const buildingIndex = this.data.buildingIndex

    // 简单校验：必须填名字、选楼栋
    if (!pickupName) {
      wx.showToast({ title: '请填取餐名', icon: 'none' })
      return
    }
    if (buildingIndex === null) {
      wx.showToast({ title: '请选楼栋', icon: 'none' })
      return
    }

    const building = this.data.buildings[buildingIndex]
    const db = wx.cloud.database()

    db.collection('orders').add({
      data: {
        item_name: item.name,
        price: item.price_after_tax,
        offer_id: item.offer_id,
        pickup_name: pickupName,
        building: building,
        status: 'pending_payment',
        created_at: new Date()
      }
    }).then(res => {
      console.log('下单成功：', res._id)
      wx.showToast({ title: '下单成功！', icon: 'success' })
      this.setData({ showOrderForm: false })
    }).catch(err => {
      console.error('下单失败：', err)
      wx.showToast({ title: '下单失败', icon: 'none' })
    })
  },
  goToMyOrders: function () {
    wx.navigateTo({
      url: '/pages/myorders/myorders'
    })
  },
  goToAdmin: function () {
    wx.navigateTo({
      url: '/pages/admin/admin'
    })
  },
  onClickPowerInfo(e) {
    const app = getApp();
    const index = e.currentTarget.dataset.index;
    const powerList = this.data.powerList;
    const selectedItem = powerList[index];
    
    // 检查是否跳过环境配置检测
    if (!selectedItem.skipEnvCheck && !app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 `miniprogram/app.js` 中正确配置 `env` 参数",
      });
      return;
    }
    if (selectedItem.link) {
      wx.navigateTo({
        url: `../web/index?url=${selectedItem.link}&title=${selectedItem.title}`,
      });
    } else if (selectedItem.type) {
      wx.navigateTo({
        url: `/pages/example/index?envId=${this.data.selectedEnv?.envId}&type=${selectedItem.type}`,
      });
    } else if (selectedItem.page) {
      wx.navigateTo({
        url: `/pages/${selectedItem.page}/index`,
      });
    } else if (
      selectedItem.title === "数据库" &&
      !this.data.haveCreateCollection
    ) {
      this.onClickDatabase(powerList, selectedItem);
    } else {
      selectedItem.showItem = !selectedItem.showItem;
      this.setData({
        powerList,
      });
    }
  },

  jumpPage(e) {
    const { type, page } = e.currentTarget.dataset;
    console.log("jump page", type, page);
    if (type) {
      wx.navigateTo({
        url: `/pages/example/index?envId=${this.data.selectedEnv?.envId}&type=${type}`,
      });
    } else {
      wx.navigateTo({
        url: `/pages/${page}/index?envId=${this.data.selectedEnv?.envId}`,
      });
    }
  },

  onClickDatabase(powerList, selectedItem) {
    wx.showLoading({
      title: "",
    });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "createCollection",
        },
      })
      .then((resp) => {
        if (resp.result.success) {
          this.setData({
            haveCreateCollection: true,
          });
        }
        selectedItem.showItem = !selectedItem.showItem;
        this.setData({
          powerList,
        });
        wx.hideLoading();
      })
      .catch((e) => {
        wx.hideLoading();
        const { errCode, errMsg } = e;
        if (errMsg.includes("Environment not found")) {
          this.setData({
            showTip: true,
            title: "云开发环境未找到",
            content:
              "如果已经开通云开发，请检查环境ID与 `miniprogram/app.js` 中的 `env` 参数是否一致。",
          });
          return;
        }
        if (errMsg.includes("FunctionName parameter could not be found")) {
          this.setData({
            showTip: true,
            title: "请上传云函数",
            content:
              "在'cloudfunctions/quickstartFunctions'目录右键，选择【上传并部署-云端安装依赖】，等待云函数上传完成后重试。",
          });
          return;
        }
      });
  },
});
