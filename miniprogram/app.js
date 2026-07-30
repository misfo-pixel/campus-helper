// app.js
const { fetchMyProfile } = require('./utils/user.js')

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
      this.globalData.profileReady = fetchMyProfile().then(profile => {
        this.globalData.openid = profile.openid
        this.globalData.roles = profile.roles
        this.globalData.profile = profile
        return profile
      }).catch(err => {
        console.error('登录失败：', err)
        return null
      })
    }
  },

});
