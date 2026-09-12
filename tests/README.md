# 测试

三套断言载荷，跑在**测试专用 Chrome profile**（`tests/.chrome-profile`，已 gitignore）里，对已登录的 linux.do 页面执行：

- [suites/console.js](suites/console.js)：功能回归，自建 mock DOM，不依赖站点内容，60 条。
- [suites/spa.js](suites/spa.js)：真实信息流 + SPA 页内路由，点击站点导航标签切换列表，验证切换后过滤照常、无残留状态、零报错，11 条。
- [suites/perf.js](suites/perf.js)：性能与抖动，加载 [fixtures/rules-sample.json](fixtures/rules-sample.json)（27 条真实规则集）并滚动加载多页，7 条断言 + 一行指标；**淡化 / 隐藏两种模式各跑一遍**（`perf-dim` / `perf-hide`）。

## 跑

```powershell
node tests/run.js          # 四跑（默认）
node tests/run.js console  # 只跑功能
node tests/run.js spa      # 只跑 SPA 路由
node tests/run.js perf     # 只跑性能两模式
```

不需要交互。run.js 先查 cookie 文件（缺失 / 没有 linux.do 条目 / 带过期时间的条目全过期，直接报错，不起浏览器），再起专用 Chrome、导入登录态、预热一轮，然后逐套跑完并关掉页面。

**为什么不用日常 profile**：Chrome 136+ 只认非默认数据目录的调试端口，用日常 profile 起调试端口会弹窗要你点允许、也不被官方支持；而且日常 profile 里的油猴 / 广告拦截扩展会污染测量。

## 输出

跑完终端只打一行摘要（全绿是 `✅ 套件：n/n 通过`），失败会把失败项与实际值一并列出；完整断言明细落盘 `tests/.last-result.json`（已 gitignore），只在需要复盘时才读。

## 不干净就停

注入前会查页面里有没有别的脚本实例（真实油猴也装了这个脚本 → 双实例，结果不可信），命中就**直接停下、不做任何断言**、退出码 1，让你先处理。专用 profile 是我们自建的，不会有你装的扩展。

## 两条硬约束

- **CSP**：脚本每份文档只允许 eval 一次，且必须在 evaluate 的同步栈内；await 之后的定时器里 eval 会被站点 CSP 拦。所以套件源码用同步 XHR 从 [serve.js](serve.js)（由 run.js 内嵌启动，127.0.0.1:8123）拉，保持同步栈。
- **预热**：perf 的量在**热页面**上（run.js 先空跑一轮）。冷缓存那次会被站点自身的加载 + hydration 拖着走，测的不是脚本。

## 判读

- 只看退出码和摘要行；失败项自带实际值，明细在 `.last-result.json`。
- 首屏 CLS 在隐藏模式下偏高是正常的：隐藏会把命中的行从布局里摘掉、下方内容上移，是模式固有代价，不是抖动。
- SPA 切换的 CLS 增量只报告 + 宽松兜底（≤0.05），站点自身重排也会产生位移。
- 只断言「行为与过滤语义」与「脚本自身开销」：不测 CSS 像素；受外部环境影响的量（如「内容到达 → 状态落地」的延迟）只报告不判定。
- 「零 JS 错误」只算脚本自己的错：`Script error.` 是跨域脚本（站点 CDN / Turnstile）的不透明报错，直接忽略；perf 另外包住 `handleAddedNodes` 捕获回调抛错。
- 登录态来自 `linux.do_cookies.txt`，过期了重新导出一份即可。
- **别连着跑回归**：linux.do 有限流，短时间反复刷新 / 导航可能被限速甚至封号。两次回归之间留间隔；调试优先 `node tests/run.js console`（自建 mock DOM，只导航一次）。
- 偶发失败先怀疑环境（网络、页面没就绪、机器负载），重试再判断，不要给环境打补丁。
- 写死的值只有分类「开发调优 = 4」「搞七捻三 = 11」；分类名与子分类 ID 都从类别树动态取。
- 不做（用户明确无需或需人工）：导出下载、导入的系统文件选择框、真实登出、真实油猴环境冒烟。
