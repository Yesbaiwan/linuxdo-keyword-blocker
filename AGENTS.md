# AGENTS.md

## 项目

Linux.do Keyword Blocker — 单文件 Tampermonkey 用户脚本（`ld-blocker.user.js`），按关键词自动隐藏/淡化 linux.do 的帖子。无构建、无依赖、纯 DOM API；文件直接装入 Tampermonkey。UI 文案使用简体中文。

## 用户需求（当前产品形态）

- 登录用户的常驻入口：头像下拉菜单标签列最底部（「个人资料」下方）的「屏蔽词」标签按钮，样式与原生标签一致；点击后菜单内容区切换为关键词管理视图。
- 未登录用户没有头像入口；油猴菜单命令「打开 Linux.do 屏蔽词设置」对所有用户**一律弹出独立悬浮面板**（不区分登录态）。
- 功能：启用开关、逗号批量添加（自动 trim/去重/滤空）、隐藏/淡化两模式、× 删除、导出、清空。
- 匹配范围：标题/分类/标签，大小写不敏感。

## 硬性约束（违反即出 bug，已踩过坑）

- 任何行为变更必须 bump `@version`——Tampermonkey 靠它推送更新；`@downloadURL`/`@updateURL` 指向 GitHub raw 文件。
- 帖子行状态只能用 `data-lkcb-state` 属性，不能用 class：Ember 异步重写行的 class，注入的类会被抹掉导致帖子「闪回来」。
- linux.do 的菜单是深度定制的 Discourse，结构假设必须以本站实测为准，不能用原版 Discourse 推断：
  - 8 个标签分属 top-tabs / bottom-tabs 两组容器，跨组监听要用 document 级委托；
  - `li#current-user` 关闭时也带 `user-menu-panel` 类，选择器会误命中——注入入口直接用 profile 按钮 id 定位；
  - 菜单每次打开都整面板重渲染、关闭即销毁：视图激活态要随之复位，入口靠观察器在面板出现时同步注入；
  - `panel-body` 是 `overflow: hidden` 固定高度，长列表必须让胶囊区自己滚动；`.panel-body-contents` 是 row-reverse 横向布局，不要往里追加块级内容；
  - 菜单内的点击/键盘事件必须 stopPropagation，否则会被菜单委托当成本地导航路由走；
  - 视图容器复用 `quick-access-panel` 类：隐藏原生面板的 CSS 必须 `:not(#lkcb-quick-access)` 排除自己；限高只允许一层，多层嵌套会裁掉底部按钮；
  - 菜单视图和悬浮面板可能并存同 id 的两份：视图内部取子元素一律用容器 scoped 查询，渲染要覆盖所有实例。
- 站点 CDN 样式会隐形覆盖元素的 display / flex-direction / width / justify-content（枚举样式表规则查不到），样式冲突以实测计算样式为准，关键属性显式声明。实例：移动 UA 下 `.quick-access-panel` 被强加 `justify-content: space-between`（桌面 UA 无此规则），导致菜单视图各块被撑出 ~117px 大空隙，v2.3 显式声明 `justify-content: flex-start` 修复。
- 悬浮面板绝不能默认渲染在页面上（会挡住「登录」按钮），只能由菜单命令触发。
- 观察器只监听 `childList + subtree`，不能加 `attributes`（脚本自己的写入会自我触发）；id 以 `lkcb-` 开头的新增节点会被观察器跳过（用于忽略自身 UI），外部测试 DOM 不要用这个前缀命名。
- 视图容器内部从 scoped 查询取子元素：菜单视图和悬浮面板可能并存同 id 的两份。

## 开发 / 测试习惯

- 改动后必须在 linux.do 本站浏览器实测验证（小步、逐项），不能用原版 Discourse 站点或纯推断代替。
- 自动化测试环境：chrome-devtools-mcp 控制的真实 Chrome（2026-09 从 ZCode 内置浏览器迁移，用户明确弃用内置浏览器），唯一测试环境。启动/注入/轮询流程、CSP 约束与 MCP 侧增强检查（真实控制台监控、网络请求清单、性能追踪、截图目检）统一见 `tests/README.md` 运行手册。真实 Chrome 下无限滚动可被合成 wheel 稳定触发；隐藏延迟均值 90–120ms 属 Ember 骨架→文本填充节奏，CLS≈0 才是闪现权威指标。仍非通用环境：可疑偶发失败先怀疑测试环境——重试再判断，不要为此在脚本或测试代码里加环境补丁。
- 会话恢复：`linux.do_cookies.txt`（Netscape 格式，已 gitignore）。登出测试后用它恢复登录；令牌有效性与登出是否吊销有关，恢复失败需用户手动登录。
- 自动化回归（五件套，全部由 Chrome DevTools MCP 按 `tests/README.md` 流程驱动；重复运行前先刷新页面）：
  - `tests/console-tests.js`：20 项功能断言（入口/规范化/过滤/模式/开关/标签切换/关闭复位/悬浮面板）+ 运行流程的独立阶段验证存储损坏回退（刷新 → 预写坏 JSON → 注入 → 断言零报错且回退默认设置）。运行按 `tests/README.md` 通用注入模式。
  - `tests/stress-test.js` + `tests/stress-keywords.txt`：97 个有意义的关键词（交易/广告/求职/技术词等真实屏蔽场景，含 `C++`、`.NET` 等特殊字符词与长句；文件为纯逗号分隔，可整行粘贴进输入框导入）同时压测悬浮面板与头像菜单视图，检查内部滚动、footer 可见、无横向溢出、滚动到底删除、过滤联动。
  - `tests/performance-test.js`：CLS（PerformanceObserver layout-shift）、隐藏延迟（行插入与 data-lkcb-state 出现的 MutationObserver 配对 + 确定性探针：克隆隐藏行剥掉标记插回，走真实观察器管线保证有样本；延迟含 Ember 骨架→文本填充时间，仅作参考——探针期 CLS≈0 才是「绘制前隐藏、无闪现」的权威证明）、长任务（注意：无脚本对照下站点自身也出现 ~3s 长任务，非脚本造成）、滚动风暴（12×1500px，合成 wheel 事件 + scrollBy——纯 scrollBy 不会触发该站加载器）、网络请求增量（Resource Timing，开头需 setResourceTimingBufferSize 扩容，默认 250 条会写满）。
  - CSP 硬约束：脚本只允许 eval 一次，且必须在首个 await 之前的同步段执行——await 之后的定时器回调里 eval 会被站点 CSP（无 'unsafe-eval'）拦截。五件套的注入点都已遵守此约束。
  - `tests/spa-test.js`：SPA 路由重建零闪现测试——真实点击「热门/最新」路由标签（`#navigation-bar`，不是侧边栏）触发 Ember 列表整体重建，页面不重载、脚本存活。验证：路由完成、重建列表中过滤照常生效、每次切换 CLS 增量 = 0（行未绘制即被隐藏的硬证据；隐藏延迟仅作参考，含骨架→文本填充时间）、零泄漏（命中关键词却未隐藏的行数为 0）、零报错。「显示 N 个新话题」按钮场景（站点实时来新帖）不自动化：无法确定性触发，且底层插入管线与路由重建/perf 探针同源，已被等效覆盖。
  - `tests/narrow-screen-test.js`：窄屏深测。视口由外部流程预设为目标窄屏后刷新再运行；覆盖悬浮面板几何与关闭、长词胶囊换行/截断（发现并修复了胶囊 content-box 溢出 bug，v2.2 加 `box-sizing: border-box`）、滑入抽屉视图、过滤、页面无横向溢出。自带 43 个长短中英混合词。**必须跑两遍**：桌面 UA（覆盖媒体查询类差异）+ 移动 UA（emulate 同时设 iPhone Safari userAgent，覆盖站点移动样式表差异——v2.3 的 justify-content bug 只有移动 UA 能复现）。390/768/320 桌面 UA 与 393/320 移动 UA 实测全绿。
  - 未覆盖（用户明确无需或需人工）：导出下载、真实登出（已验证过一次）、真实 Tampermonkey 环境冒烟。
- git 提交/推送需用户明确发话，不要自行操作。
