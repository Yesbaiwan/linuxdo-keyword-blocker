# AGENTS.md

## 项目

Linux.do Keyword Blocker — 单文件 Tampermonkey 用户脚本（`ld-blocker.user.js`），用「类别/标签/标题」规则自动隐藏/淡化 linux.do 帖子。无构建、无依赖、纯 DOM API，UI 文案简体中文。

## 产品行为

- 强制登录：头部有 `#current-user` 才启动；未登录不过滤、无任何 UI；SPA 登录后由观察器自动启动。
- 入口：头像菜单标签列最底部的「屏蔽规则」按钮，点击后菜单内容区切换为规则管理视图。
- 功能：总开关；规则 = 类别选择器 + 标签 + 标题（至少填一项）；单规则启停勾选框（停用画删除线）；行内编辑（在本行下方展开表单，保存/取消都在本行完成，不回填顶部表单）；可搜索类别 picker（输入即过滤、点选/回车选中、× 清除、失焦恢复原值）；隐藏/淡化两模式（默认淡化）；× 删除、导出 JSON、清空。刻意不做已添加规则的搜索（用户明确要求）。
- 匹配：规则内已填字段**全部命中**（AND），任一规则命中即处理该行。类别按徽章 `data-category-id` 数字精确匹配所选分类本身，**不连带子分类**（整类屏蔽用 Discourse 自带分类静音）；标签按 `a.discourse-tag` 文字精确匹配（子串不命中）；标题包含匹配；均大小写不敏感。
- 存储：`{ enabled, rules: [{category, tag, title, enabled}], hideMode }`；旧 `keywords` 数组读取时自动迁移为仅标题规则。
- 类别树：运行时拉 `/site.json`，GM 缓存 7 天，带版本号并逐条校验格式；失败时空索引，已存类别规则仍按徽章 ID 生效。有子分类的分类统一显示「（不带等级）」后缀。子分类页（如 /c/develop/develop-lv1/20）行内无徽章，类别规则天然不命中。

## 硬性约束（踩过坑，违反即出 bug）

- 帖子行状态只能用 `data-lkcb-state` 属性，不能用 class：Ember 会异步重写行的 class。
- 菜单是深度定制的 Discourse，结构以本站实测为准，不能用原版 Discourse 推断：8 个标签分属两组容器（跨组监听用 document 级委托）；入口用 profile 按钮 id 定位（`li#current-user` 关闭时也带 `user-menu-panel` 类，选择器会误命中）；菜单每次打开整面板重渲染、关闭即销毁，视图激活态随之复位；`panel-body` 是 `overflow: hidden` 固定高度，长列表让规则区自己滚动；`.panel-body-contents` 是 row-reverse 横向布局，别往里追加块级内容；菜单内点击/键盘事件必须 stopPropagation；视图容器复用 `quick-access-panel` 类，隐藏原生面板的 CSS 必须 `:not(#lkcb-quick-access)` 排除自己，限高只允许一层。
- 站点 CDN 样式会隐形覆盖 display/flex-direction/justify-content 等（枚举样式表查不到），关键属性显式声明，以实测计算样式为准。
- 类别 picker 下拉必须文档流内联展开，禁止浮层（transform 祖先劫持 fixed、滚动容器裁剪 absolute）；picker 的 `flex: 1` 只能用于横向 `.lkcb-row`。
- 观察器只监听 `childList + subtree`，禁加 `attributes`（脚本自身 data 写入会自我触发）。匹配缓存**只存命中结果**：站点会原地摘空行内容再填回（置顶公告帖必现），骨架期算出的不命中落缓存会永久漏过滤；`handleAddedNodes` 对文本节点插入也要提升宿主行重算（站点填标题用文本节点，只认元素节点同样漏）。
- id 以 `lkcb-` 开头的新增节点被观察器跳过（忽略自身 UI），测试 DOM 不要用该前缀。
- `@version` 由用户管理，agent 不得擅自改动。

## 开发 / 测试

- 改动后必须在 linux.do 本站实测（小步逐项），不能用原版 Discourse 或推断代替。
- 测试环境：chrome-devtools-mcp 控制的真实 Chrome（唯一环境），注入流程与 CSP 约束见 `tests/README.md`。可疑偶发失败先怀疑环境，重试再判断，不加环境补丁。
- 会话恢复：`linux.do_cookies.txt`（Netscape 格式，已 gitignore）。
- 自动化回归六套（`tests/suites/`，数据在 `tests/fixtures/`，入口 `tests/README.md`；重复运行前先刷新页面）：

| 套件             | 覆盖                                                                                                                                  | 结果标志                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| console.js       | 34 项功能断言（登录门槛/CRUD/picker/精确匹配/AND/启停/行内编辑/存储损坏回退），自建 mock DOM                                          | `__lkcbTestResults`       |
| rule-stress.js   | 17 条组合规则匹配语义，影子匹配器逐行比对；分类 ID（4=开发调优、11=搞七捻三、14=资源荟萃、35=Lv1）取自 2026-09 实测，站点改 ID 需同步 | `__lkcbRuleStressResults` |
| bulk-stress.js   | 97 词仅标题规则压 UI 承载（滚动/footer/溢出/删除/过滤联动）                                                                           | `__lkcbStressResults`     |
| performance.js   | CLS/隐藏延迟/长任务/滚动风暴/网络增量                                                                                                 | `__lkcbPerfResults`       |
| spa.js           | 热门/最新路由重建零闪现、零泄漏、CLS=0                                                                                                | `__lkcbSpaResults`        |
| narrow-screen.js | 窄屏抽屉视图/过滤/无横向溢出；桌面 UA + 移动 UA 各跑一遍                                                                              | `__lkcbNarrowResults`     |

- CSP 硬约束：脚本在每份文档只允许 eval 一次，且必须发生在 evaluate 的同步栈内（await 后再 eval 会被站点 CSP 拦截）。
- 未覆盖（用户明确无需或需人工）：导出下载、真实登出、真实 Tampermonkey 环境冒烟。
- git 提交/推送需用户明确发话。
