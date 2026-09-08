# 测试运行手册（Chrome DevTools MCP）

五件套（console / stress / performance / spa / narrow）均由 chrome-devtools-mcp 控制真实 Chrome 在 linux.do 本站运行。每个 `tests/*.js` 是「页内断言载荷」，本手册是标准的 MCP 驱动流程。**2026-09 起为唯一测试环境**（ZCode 内置浏览器已弃用）。

## 一、环境前提

1. chrome-devtools-mcp 已连接，浏览器为真实 Chrome；
2. linux.do 已登录（脚本强制登录：未登录时脚本完全不启动，所有断言零响应）；
3. 优先用**无 Tampermonkey 的干净 profile**（被测脚本由我们注入；若浏览器里装着真实 Tampermonkey，会出现双实例，结果不可信）。扩展也越少越好——广告拦截类扩展会制造 `ERR_BLOCKED_BY_CLIENT` 控制台噪音，干扰第五节的错误归因；
4. 本地服务已启动（见下）。

## 二、启动本地服务

```bash
node tests/serve.js    # 监听 127.0.0.1:8123，服务根目录 = 项目根
```

页面里的测试用**同步 XHR** 从这里拉取脚本与测试源码。站点 CSP 没有 connect-src 限制，localhost 可访问；同步 XHR 保证后续 eval 仍处于 evaluate 的同步栈内。

## 三、通用注入模式（每套测试相同）

1. **预置**（如有）：视口模拟、刷新页面、等页面就绪（约 5s，30 行帖子出现）；
2. **注入**（一次 `evaluate_script`，函数体必须**纯同步、无 await**）：

```js
() => {
  const get = (url) => {
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.send(null);
    if (x.status !== 200) throw new Error('fetch fail ' + url);
    return x.responseText;
  };
  window.__LKCB_SOURCE__ = get('http://127.0.0.1:8123/ld-blocker.user.js');
  // stress 另需：window.__LKCB_STRESS_KEYWORDS__ =
  //   get('.../tests/stress-keywords.txt').split(/[\n,，]/).map(k => k.trim()).filter(Boolean);
  (0, eval)(get('http://127.0.0.1:8123/tests/<对应测试文件>.js'));
  return 'started';
}
```

3. **轮询**：短间隔多次 `evaluate_script` 读取结果标志（每次 sleep ≤ 25s——工具级超时约 30s）：

| 测试 | 结果标志 |
|---|---|
| console | `window.__lkcbTestResults`（`__lkcbTestsRunning` 结束标志） |
| stress | `window.__lkcbStressResults` |
| performance | `window.__lkcbPerfResults`（附 `__lkcbPerfStage`） |
| spa | `window.__lkcbSpaResults` |
| narrow | `window.__lkcbNarrowResults` |

### CSP 硬约束（违反必挂）

脚本在每份文档里**只允许 eval 一次**，且必须发生在 evaluate 的**同步栈**内。
`await` 之后的定时器回调里再 eval 会被站点 CSP（无 `unsafe-eval`）拦截。
实验已两次证实（同步栈内的嵌套 eval 同样豁免）。等待页面就绪的 sleep 放在**独立的 evaluate 调用**里，不要和注入混在一个 async 函数中。

## 四、每套测试的预置差异

| 测试 | 预置 |
|---|---|
| console | 无（自建 mock DOM） |
| stress | 无（关键词从 stress-keywords.txt 拉取解析） |
| performance | 刷新后停在 /latest 列表页 |
| spa | 刷新后停在 /latest（页内自点路由标签） |
| narrow | `emulate` 视口（如 `390x844x1,mobile,touch`）→ 刷新 → 运行；**跑两遍**：一遍桌面 UA、一遍移动 UA（emulate 同时设 `userAgent` 为 iPhone Safari——站点移动样式表只在移动 UA 下生效，v2.3 的 justify-content 覆盖 bug 只有移动 UA 能复现）；测完用无参 `emulate` 清除模拟 |

## 五、MCP 侧增强检查（内置浏览器时代做不了、现在能做）

每次测试运行后按需执行，作为页内断言之外的第二层验证：

1. **真实控制台监控**：`list_console_messages` 按 `error` 类型过滤。页内的「零 JS 错误」断言只收集 `window.onerror`/`unhandledrejection`，控制台里被站点吞掉的错误只有这里能看到。**必须做归因**：站点自身有噪音——linux.do 自带的 gtm.js 会在 CSP 下产生 eval 拦截报错（调用栈在 gtm.js/chat 插件，与脚本无关），浏览器扩展也会产生 `ERR_BLOCKED_BY_CLIENT`。判定标准：错误栈里出现 `eval`、`<anonymous>` 且时间点对应我们的注入，或涉及 `lkcb` 相关代码才算脚本问题；站点级噪音记录并忽略。
2. **真实网络请求清单**：`list_network_requests`——performance 的滚动风暴后应能看到对 `/latest.json` 等数据接口的真实请求（页内 Resource Timing 增量可与它交叉核对）；
3. **真实性能追踪**：`performance_start_trace` / `performance_stop_trace`——获得 LCP/CLS/INP 的浏览器级 insight（比页内 PerformanceObserver 更全，含 Core Web Vitals 评分）；
4. **渲染目检**：`take_screenshot`——面板/抽屉/规则行布局的视觉确认（页内几何断言只量矩形，目检能发现颜色、遮挡类问题）；
5. **请求详情**：`get_network_request`——需要核对某个具体请求的响应体时使用。

## 六、清理

- 每套测试自带 try/finally：还原测试前的 localStorage 设置（没有则移除）、移除注入面板、关闭打开的菜单；
- 测试跑完**刷新页面**一次（清掉 eval 注入的脚本实例与 data 属性残留）；
- 用过的模拟视口记得清除。
