# AGENTS.md

## 项目

Linux.do Keyword Blocker —— 单文件 Tampermonkey 用户脚本（`ld-blocker.user.js`），按「类别 / 标签 / 标题」规则自动隐藏或淡化 linux.do 帖子。无构建、无依赖、纯 DOM API，UI 文案简体中文，只面向桌面 Chrome。

## 行为与匹配（改脚本前先对齐）

- 强制登录：头部有 `#current-user` 才启动；未登录不过滤、无任何 UI，SPA 登录后由观察器自动启动。
- 入口：油猴菜单命令或 Ctrl+Q 打开悬浮面板（遮罩居中 540px 卡片，挂 body 常驻）；Esc / 点遮罩 / × 关闭并复位编辑态。
- 面板：总开关；规则 = 类别下拉 + 标签（每框一个，最多 3 个，仅剩 1 个框时不给 ×）+ 标题，至少填一项；「零标签」复选框在标签行内，勾选后标签框与「+」收起；单规则启停（停用画删除线）；行内编辑在本行下方展开，与添加表单同一套字段；任何重建列表的操作（添加 / 删除 / 清空 / 保存、类别树就绪）都会收起编辑表单，只有单规则启停是就地更新；类别下拉外观同普通下拉框，输入即过滤、点选 / 回车选中、× 清除、失焦恢复；候选列表是 fixed 浮层，贴输入框上下方展开；隐藏 / 淡化两模式（默认淡化）；导入 / 导出 JSON（同一格式规则数组，导入为追加模式：文件内部重复、与现有规则重复都跳过，只收新规则，提示里带跳过计数）；清空。已添加规则的搜索刻意不做。
- 过滤范围：首页 / 最新 / 未读 / 热门 / 分类列表页（`tr.topic-list-item` 等）与搜索结果页（`.fps-result`）。搜索结果内层也带 `data-topic-id`，状态只打最外层行，内层清空。
- 匹配：规则内已填字段全部命中（AND），任一规则命中即处理；均大小写不敏感。类别按徽章 `data-category-id` 数字精确匹配所选分类本身，默认不连带子分类，可选「所有等级」覆盖自身 + 全部等级后代；标签按 `a.discourse-tag` 文字精确匹配（子串不命中），一条规则最多 3 个、全部存在才命中；「零标签」只命中零标签帖（与标签互斥）；标题包含匹配。
- 存储：`{ enabled, rules: [{category, allLevels, tags, noTag, title, enabled}], hideMode }`，只认这一种格式。
- 类别树：运行时拉 `/site.json`，GM 缓存 7 天；拉不到时已存类别规则仍按徽章 ID 生效。下拉排列「（所有等级）→（不带等级）→ 各等级子分类（缩进）」，无子分类的只给裸名字。

## 硬性约束（违反即出 bug）

- 行状态只用 `data-lkcb-state`（`hidden`/`dimmed`，与 `hideMode` 的 `hide`/`dim` 是两回事，必须映射），不能用 class：Ember 会异步重写行的 class。
- 站点 CDN 样式会隐形覆盖 display / flex-direction / justify-content / width（枚举样式表查不到），关键属性显式声明，以实测计算样式为准。全局 `select { width: 220px }` 会撑宽下拉，故处理模式下拉用 `width: fit-content`。
- 面板里的框按内容给宽，不撑满整行：处理模式下拉 `width: fit-content`；类别输入框与标题框等宽（`--lkcb-field-w` 是输入框自身宽度，清除键与箭头在框外；`syncFieldWidth()` 用 canvas 量最长分类展示名 + 子分类缩进算出），`#lkcb-panel` 留 190px 兜底。改分类展示名格式时同步看这里。
- 头部标题 class 是 `.lkcb-head`，表单关键词输入框是 `.lkcb-title`，别混用。
- 站点给 `input` 塞 `margin: 0 0 9px`、给 checkbox 塞四周 margin：面板内一律 `margin: 0` 归零，控件高度统一（输入框 32px、「+」32×32）。标签的「×」绝对定位浮在框内右侧。
- 面板内 `hidden` 元素靠 `#lkcb-panel [hidden] { display: none !important }` 兜底（`.lkcb-tags` 自带 `display: flex` 会盖掉 `hidden`）。
- 类别下拉候选列表必须 `position: fixed`（不参与面板布局，展开不撑高面板）；位置由 `reposition()` 按输入框 rect 算，贴下方、下方不够且上方宽裕时上弹；面板滚动与窗口缩放都要重新贴位（`activePicker` 记当前展开的 picker）。
- 观察器只监听 `childList + subtree`，禁加 `attributes`（脚本自身写 data 会自我触发）。
- 匹配缓存：「topicId → {规则版本, 内容指纹, 命中规则}」，命中与未命中都缓存，指纹（标题 + 类别 ID 集合 + 标签）一变就重算，骨架期算出的「不命中」在内容填进来后自动失效。不能只存命中，也不能只按 topicId 复用。规则变更靠 `matchVersion` 整批失效，缓存超 4000 条整批丢弃。
- `handleAddedNodes` 先把行收进 Set 去重、批次末尾每行只判定一次（站点分多次插入骨架 / 标题 / 徽章）。文本节点只提升宿主行、别查后代；不要在容器节点上读 `textContent`（遍历整棵子树）。
- 类别树就绪前（`ready === false`）不落任何行状态，等树到齐统一扫一次（否则页面会跳两次）。
- 标题选择器不能逗号合并：置顶帖的空文本「置顶」按钮在文档序上先于标题。
- id 以 `lkcb-` 开头的新增节点被观察器跳过，测试 DOM 不要用该前缀。
- `@version` 由用户管理，不得改动。

## 开发 / 测试

- 改动后在 linux.do 本站实测（最新、未读、搜索三类页面各看一次），不用推断代替。
- **别对站点做快速连续刷新 / 导航**：会触发限流，严重时封号。回归不要连着跑，两次之间留间隔；调试优先 `node tests/run.js console`（自建 mock DOM，只导航一次）。
- 一条命令跑回归：`node tests/run.js [console|spa|perf|both]`。跑在测试专用 Chrome profile（`tests/.chrome-profile`，已 gitignore），登录态每次从 `linux.do_cookies.txt` 导入；套件覆盖与判读见 [tests/README.md](tests/README.md)。
- 注入前先查页面里有没有别的脚本实例，有就停下告诉用户，别带着污染测（专用 profile 是我们自建的，不会有你装的扩展）。
- 隐私红线：`tests/serve.js` 只放行白名单（`ld-blocker.user.js` + `tests/suites/` + `tests/fixtures/`），其余 403——它带 CORS `*`，项目根下就是 `linux.do_cookies.txt`。cookie 文件永远不进 git。
- chrome-devtools-mcp 只用于看页面 / 调试，不跑测试。
- git 提交 / 推送需用户明确发话。
