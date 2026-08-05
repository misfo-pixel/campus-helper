# 明尼助手

面向明大中国学生的校园服务小程序。微信小程序 + 微信云开发（CloudBase），无自建服务器、无独立后台网站——管理职能按角色内嵌在小程序里。

## 模块

首页（`pages/home`）按开关渲染入口：

| 模块 | 入口页 | 说明 |
|---|---|---|
| 二手市场 | `pages/market` | 发布、浏览、举报 |
| 公寓转租 | `pages/subletmarket` | 找房、转租、找室友 |
| 任务委托 | `pages/taskmarket` | 代买、代取等 |
| 校外服务 | `pages/shoplist` | 商家自营点单 + 商家工作台 + 批次配送 |
| 意见反馈 | `pages/feedback` | |

## 功能开关

见 `miniprogram/config.js`：

- `SHOP_MODULE_ENABLED = true` — 校外服务（商家自营）。平台不经手资金：订单里没有支付状态，买家在小程序外自行转账，商家收到钱后在工作台点「接单」。
- `FOOD_MODULE_ENABLED = false` — 老的外卖拼团，提审期间下线。**恢复前必须先替换掉「上传付款截图 + 管理员确认收款」的流程**，引导站外支付是明确违规。恢复步骤写在 `config.js` 注释里。

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

`autoExpire` 是定时触发器（每天 02:00），其余云函数由前端 `wx.cloud.callFunction` 调用。

## 参考

[云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
