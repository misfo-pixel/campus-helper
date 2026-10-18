# 生活百科（Wiki 模块）

单人维护的「核实过的答案库」。价值在可信度，不在数量：前期不开放自由编辑，
内容只由管理员维护，普通用户只能读到核实过的词条。

## 数据模型（云数据库集合，都要在控制台手动建）

- `wiki_categories`：`{ name, icon, order }`——分类，order 小的在前
- `wiki_articles`：`{ title, categoryId, summary, content(Markdown), tags[],
  applicableTo[], sources[{title,url}], status, disclaimer, verifiedAt, updatedAt,
  viewCount, helpfulCount, outdatedCount }`
  - `status`：`draft`（AI 起草/待核实，普通用户不可见）/ `verified`（已核实，对外展示）
  - `disclaimer: true` 的词条（签证、CPT/OPT、报税、身份类）详情页顶部固定显示
    「仅供参考，请以 ISSS / 官方信息为准」。这类词条只放官方链接 + 转述官方要点，
    不自己下结论。
- `wiki_search_logs`：`{ keyword, resultCount, openid, created_at }`——每次搜索都记，
  没结果的关键词是选题来源

**集合权限全部设成「仅创建者可读写」**：所有读取都走云函数 `wikiBrowse`
（它在服务端过滤 `status=verified`，草稿对普通用户返回「词条不存在」，
不提示「审核中」）。管理员带 `preview=1` 可预览草稿。

## 云函数

- `wikiBrowse`：唯一读取入口。action：`home`（分类 + 最近更新 + 热门）、
  `list`（分类分页，每页 20）、`detail`（阅读数 +1，失败不影响阅读）、
  `search`（标题/标签/摘要模糊匹配，限 20 条，写搜索日志）
- `wikiSeed`：仅管理员（users.roles 含 super_admin / market_admin）。按标题去重，
  可重复跑。起底子：6 个分类 + 5 条示例词条（3 条 verified、2 条 draft）

部署：微信开发者工具里右键这两个目录 → 「上传并部署：云端安装依赖」。

## 页面

- `pages/wiki/wiki`：首页。假搜索框（点了跳搜索页）+ 分类网格 + 最近更新 + 热门
- `pages/wikilist/wikilist`：分类词条列表，到底自动翻页
- `pages/wikidetail/wikidetail`：详情。一句话结论（summary）永远在正文前面；
  正文 Markdown 由 `utils/wikiMd.js` 渲染（自写的小解析器，支持 ##/### 标题、
  列表、引用、加粗、链接；不引 towxml/wemark，省几百 KB 包体积）；
  来源链接点一下复制（小程序里点不开外链）；分享卡片标题 = 词条标题，直达本页
- `pages/wikisearch/wikisearch`：搜索。没结果引导去意见反馈告诉我们想查什么

首页入口格在 `pages/home/home.js` 的 TILES，开关是 `config.js` 的
`WIKI_MODULE_ENABLED`（关掉入口消失，数据还在）。

## 内容流程（红线）

1. 从群聊高频问题里挑题（你自己提供清单）
2. AI 按模板起草：TL;DR + 适用人群 + 步骤/关键数字 + 来源。**不确定的数字、
   地址、链接一律写「待核实」，sources 留空，不许编**
3. 起草进库就是 `draft`，你逐条核实、补官方来源后，在控制台把 `status`
   改成 `verified` 并填 `verifiedAt`

## 测试步骤

1. 控制台建 4 个集合（权限「仅创建者可读写」）
2. 部署 wikiBrowse、wikiSeed
3. 用管理员账号在小程序里随便触发一次 wikiSeed（或控制台云函数测试里跑），
   确认分类和 5 条词条进库
4. 首页点「生活百科」：能看到分类、最近更新、热门；草稿词条不出现
5. 搜索「报税」能出结果；搜「asdf」没结果并出现「告诉我们」按钮；
   控制台 wiki_search_logs 里两条都在
6. 详情页点右上角分享，卡片标题是词条标题，从分享卡片点开直达该词条

## 提审前检查

- 百科是管理员单向发布内容，不是 UGC，但要确认服务类目覆盖「信息查询」；
  以小程序后台「设置 → 基本设置 → 服务类目」为准
- 签证/报税类词条核实一遍 disclaimer 都在

## 还没做（按计划分期）

- Phase 2：词条内「有帮助 / 过时了 / 补充纠错」按钮 + wiki_suggestions 集合 +
  内容安全校验
- Phase 3：管理端（批量导入 Markdown、过时提醒、没结果关键词统计、阅读/分享统计）
- Phase 4（暂缓）：开放编辑、版本历史、积分
