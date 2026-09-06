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
- 站点 CDN 样式会隐形覆盖元素的 display / flex-direction / width（枚举样式表规则查不到），样式冲突以实测计算样式为准，关键属性显式声明。
- 悬浮面板绝不能默认渲染在页面上（会挡住「登录」按钮），只能由菜单命令触发。
- 观察器只监听 `childList + subtree`，不能加 `attributes`（脚本自己的写入会自我触发）；id 以 `lkcb-` 开头的新增节点会被观察器跳过（用于忽略自身 UI），外部测试 DOM 不要用这个前缀命名。
- 视图容器内部从 scoped 查询取子元素：菜单视图和悬浮面板可能并存同 id 的两份。

## 开发 / 测试习惯

- 改动后必须在 linux.do 本站浏览器实测验证（小步、逐项），不能用原版 Discourse 站点或纯推断代替。
- 当前自动化测试跑在 ZCode 内置浏览器环境里，不是通用环境：遇到可疑的偶发失败（超时、点击不生效、CSP 拦截等）先怀疑测试环境——刷新重试再判断，不要为此在脚本或测试代码里加环境补丁。
- 会话恢复：`linux.do_cookies.txt`（Netscape 格式，已 gitignore）。登出测试后用它恢复登录；令牌有效性与登出是否吊销有关，恢复失败需用户手动登录。
- 自动化回归（三件套，均在 linux.do 控制台粘贴或由工具流程注入运行；重复运行前先刷新页面）：
  - `tests/console-tests.js`：20 项功能断言（入口/规范化/过滤/模式/开关/标签切换/关闭复位/悬浮面板）。运行前需把脚本源码注入 `window.__LKCB_SOURCE__`。
  - `tests/stress-test.js` + `tests/stress-keywords.txt`：97 个有意义的关键词（交易/广告/求职/技术词等真实屏蔽场景，含 `C++`、`.NET` 等特殊字符词与长句；文件为纯逗号分隔，可整行粘贴进输入框导入）同时压测悬浮面板与头像菜单视图，检查内部滚动、footer 可见、无横向溢出、滚动到底删除、过滤联动。
  - `tests/performance-test.js`：CLS（PerformanceObserver layout-shift）、隐藏延迟（行插入与 data-lkcb-state 出现的 MutationObserver 配对 + 确定性探针：克隆隐藏行剥掉标记插回，走真实观察器管线，实测 avg 0ms/max 1ms；探针期 CLS≈0 即「绘制前隐藏、无闪现」的证明）、长任务（注意：无脚本对照下站点自身也出现 ~3s 长任务，非脚本造成）、滚动风暴（12×1500px，合成 wheel 事件 + scrollBy——纯 scrollBy 不会触发该站加载器；合成滚动下无限滚动仍偶发不加载，属站点行为）、网络请求增量（Resource Timing，开头需 setResourceTimingBufferSize 扩容，默认 250 条会写满）。
  - CSP 硬约束：脚本只允许 eval 一次，且必须在首个 await 之前的同步段执行——await 之后的定时器回调里 eval 会被站点 CSP（无 'unsafe-eval'）拦截。三件套的注入点都已遵守此约束。
  - 未覆盖（用户明确无需或需人工）：导出下载、真实登出（已验证过一次）、SPA 路由往返、窄屏 slide-in 深测。
- git 提交/推送需用户明确发话，不要自行操作。
