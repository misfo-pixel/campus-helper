# 明尼助手

面向明大中国学生的校园服务小程序。微信小程序 + 微信云开发（CloudBase），无自建服务器、无独立后台网站——管理职能按角色内嵌在小程序里。

## 模块

首页（`pages/home`）按开关渲染入口：

| 模块 | 入口页 | 说明 |
|---|---|---|
| 二手市场 | `pages/market` | 发布、浏览、举报 |
| 公寓转租 | `pages/subletmarket` | 找房、转租、找室友 |
| 任务委托 | `pages/taskmarket` | 代买、代取等 |
| 校外服务 | `pages/shoplist` | 商家自营点单 + 商家工作台 + 批次配送（默认关闭） |
| 意见反馈 | `pages/feedback` | |

校外服务里的配送可以外包给配送队：队长在 `pages/teamdashboard` 按「批次 × 商家」领活，商家和配送队之间的配送费在 `pages/settlement` 对账（`pending → paid → settled`）。平台全程不经手资金。

## 功能开关

见 `miniprogram/config.js`：

- `SHOP_MODULE_ENABLED = false` — 校外服务（商家自营）。首次提审关闭：个人主体报不了餐饮类目，且「按商家收款方式在小程序外付款」同样属于引导站外支付。关掉后首页入口消失，其余模块不受影响。
- `FOOD_MODULE_ENABLED = false` — 老的外卖拼团，提审期间下线，页面也被 `project.config.json` 的 `packOptions.ignore` 排除在上传包外。**恢复前必须先替换掉「上传付款截图 + 管理员确认收款」的流程**，引导站外支付是明确违规。恢复步骤写在 `config.js` 注释里。
- `DEBUG_TIMING = false` — 请求延迟测量，开着时打印 `[timing]` 日志并在市场页显示测试按钮。**提审前必须关掉。**

## 本地运行

1. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)导入本目录（AppID 见 `project.config.json`）。
2. 在 `miniprogram/app.js` 里把 `env` 换成你自己的云开发环境 ID。
3. 在开发者工具里对 `cloudfunctions/` 下的每个云函数右键「上传并部署：云端安装依赖」。
4. 给 `autoExpire` 和 `keepWarm` 上传触发器（配置在各自的 `config.json` 里）。
5. 在云数据库里给自己的 `users` 记录加上 `super_admin` 角色，即可看到管理入口。

`project.private.config.json` 是开发者工具的本地设置，不入库。

## 角色

用户角色存在 `users.roles` 数组里，新用户默认 `['student']`。管理权限在云函数内校验（见 `auditShop`、`handleReport`、`deliveryManage`），不依赖前端判断：

- `super_admin` — 全部权限
- `market_admin` — 二手市场：删帖、处理举报
- `food_admin` — 商家审核、配送配置
- `sublet_admin` / `task_admin` — 对应板块的删帖权限

管理入口在「我的」页面按角色显示：商家审核 `pages/shopaudit`、举报处理 `pages/reports`、配送配置 `pages/deliveryconfig`、结算 `pages/settlement`。

## 目录

```
miniprogram/       小程序前端
  config.js        功能开关
  pages/           页面
  utils/           公共方法
cloudfunctions/    云函数，权限校验都在这里
```

`autoExpire` 是定时触发器（每天 02:00），`keepWarm` 每 5 分钟调一次常用云函数防止冷启动，其余云函数由前端 `wx.cloud.callFunction` 调用。

## 参考

[云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
