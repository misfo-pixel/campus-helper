// app.js
const { fetchMyProfile, readCachedProfile } = require('./utils/user.js')

App({
  onLaunch: function () {
    this.globalData = {
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具右上顶部工具栏点击云开发按钮打开获取
      env: "cloud1-d1gv6rdj91aa53558",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
      // 全局只在这里登录一次，页面等 profileReady 复用结果。
      // 新用户如果并发调 login，两次都会查不到记录、各建一条，所以不要在页面里再登录一遍。
      //
      // login 是云函数，闲置一段时间后容器会被回收，下次调用要先冷启动，1~3 秒。
      // 所以这里先拿上次存在本地的资料立刻可用，网络那份回来了再替换：
      //   有缓存 → profileReady 立刻 resolve，页面秒开
      //   没缓存（第一次装）→ profileReady 等网络，跟以前一样
      const cached = readCachedProfile()
      // 缓存必须是「完整」的才能当作 profileReady 的快路径。
      // 旧版 login 云函数不返 uid，那时写下的缓存 openid 齐全但 uid 是空的，
      // 直接拿来用会让所有依赖 uid 的功能（分享/预览公开主页）静默失效。
      // 缺 uid 就当没缓存，老老实实等一次网络，之后缓存被重写就恢复秒开。
      if (cached && cached.openid && cached.uid) {
        this.globalData.openid = cached.openid
        this.globalData.roles = cached.roles || []
        this.globalData.profile = cached
        this.globalData.profileReady = Promise.resolve(cached)
      }

      const fresh = fetchMyProfile().then(profile => {
        this.globalData.openid = profile.openid
        this.globalData.roles = profile.roles
        this.globalData.profile = profile
        return profile
      }).catch(err => {
        console.error('登录失败：', err)
        return cached || null   // 网络挂了就继续用缓存，别把整个小程序卡死
      })

      // 需要「一定是最新」的地方（比如管理入口）可以等 profileFresh
      this.globalData.profileFresh = fresh
      if (!this.globalData.profileReady) this.globalData.profileReady = fresh
    }
  },

});
