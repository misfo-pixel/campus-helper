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
- `ops_admin` — 配送相关的运营权限（商家和配送队都不再审核，提交即生效）
- `sublet_admin` / `task_admin` — 对应板块的删帖权限

管理入口在「我的」页面按角色显示：举报处理 `pages/reports`、结算 `pages/settlement`。

**商家没有事前审核**：填完资料提交就有店，默认打烊，自己切「营业中」才上架。内容治理走事后路线——机检（`contentCheck`）+ 用户举报（`submitReport`）+ 人工复核下架（`handleReport`）。店铺被判违规时不删记录，而是强制 `status: 'closed'` 并打 `takedown` 标记，商家自己切不回营业。

**配送队也没有事前核对**（2026-09-20 撤掉，`pages/shopaudit` 和 `deliveryManage` 的 `listForAudit` / `audit` 一并删除）：建队即可用。原来留着核对是因为队伍会碰到别人的订单和买家联系方式；现在平台既不派单也不下发买家信息，一条配送请求里只有店长自己的微信。

队伍也没有「营业中 / 打烊」开关。能不能接活由**可配送时段**（`delivery_teams.availability`，队长在配送工作台填「哪天几点能出车」）表达：店铺设置里那个**送达时刻前后各 30 分钟**（取货、过去、交接都要时间）这一整段落在某条时段里，店长才选得中这支队，盖不住的在表单里置灰；同一天里相邻的时段会先合并再判断，一条都不填 = 谁也选不到，等于打烊。判断在 `miniprogram/utils/shopForm.js` 的 `markTeams` 里（开店向导和小店设置共用），服务端只拦「这支队不存在」——队长随时会改时段，服务端一卡，店长连改个营业时间都保存不了。

红线改用**负面清单前置**而不是按品类分发条款：`components/banBar` 常驻在店铺设置和商品编辑页顶部，所有商家看同一份禁售清单，完整版在《商家责任告知书》第五节。《商家责任告知书》里食品相关的义务改成条件式表述（「如果你销售食品，你还必须…」），不做按分类的条件渲染。商家可在店铺设置里写一段 `order_notice`（下单须知），展示在店铺页——平台不生成也不审这段。

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
