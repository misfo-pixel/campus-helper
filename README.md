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

- `SHOP_MODULE_ENABLED = true` — 校外服务（商家自营）。关掉后首页入口消失，其余模块不受影响。**提审前需先解决**：「按商家收款方式在小程序外付款」属于引导站外支付。
- `DEBUG_TIMING = false` — 请求延迟测量，开着时打印 `[timing]` 日志并在市场页显示测试按钮。**提审前必须关掉。**

老的外卖拼团模块（`FOOD_MODULE_ENABLED`、`pages/index`、`pages/myorders`）已于 2026-09-19 删除，功能由校外服务完整覆盖，需要时从 git 历史取回。配套的一次性迁移入口（商家菜单页「从旧外卖菜单导入」+ `shopManage` 的 `importLegacyMenu`）已于同日移除，`menu_items` 集合在代码里已无任何引用，可在云开发控制台删除。

## 本地运行

1. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)导入本目录（AppID 见 `project.config.json`）。
2. 在 `miniprogram/app.js` 里把 `env` 换成你自己的云开发环境 ID。
3. 在开发者工具里对 `cloudfunctions/` 下的每个云函数右键「上传并部署：云端安装依赖」。
4. 给 `autoExpire` 和 `keepWarm` 上传触发器（配置在各自的 `config.json` 里）。
5. 在云数据库里给自己的 `users` 记录加上 `super_admin` 角色，即可看到管理入口。

`project.private.config.json` 是开发者工具的本地设置，不入库。

## 角色

用户角色存在 `users.roles` 数组里，新用户默认 `['student']`。管理权限在云函数内校验（见 `handleReport`、`deliveryManage`），不依赖前端判断：

- `super_admin` — 全部权限
- `market_admin` — 二手市场：删帖、处理举报
- `food_admin` — 配送队核对、配送配置（商家不再审核，提交即开店）
- `sublet_admin` / `task_admin` — 对应板块的删帖权限

管理入口在「我的」页面按角色显示：配送队核对 `pages/shopaudit`、举报处理 `pages/reports`、结算 `pages/settlement`。

**商家没有事前审核**：填完资料提交就有店，默认打烊，自己切「营业中」才上架。内容治理走事后路线——机检（`contentCheck`）+ 用户举报（`submitReport`）+ 人工复核下架（`handleReport`）。店铺被判违规时不删记录，而是强制 `status: 'closed'` 并打 `takedown` 标记，商家自己切不回营业。配送队仍需核对，因为队伍会接触到别人的订单、买家联系方式和结算。

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
