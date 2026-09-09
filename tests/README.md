# 测试运行手册（Chrome DevTools MCP）

六套页内断言载荷由 chrome-devtools-mcp 控制真实 Chrome 在 linux.do 本站运行（2026-09 起为唯一测试环境）。

## 目录

```
tests/
├── serve.js                本地静态服务（node tests/serve.js，监听 127.0.0.1:8123）
├── suites/                 页内断言载荷，由 MCP 注入页内 eval 运行
│   ├── console.js          功能回归 34 项（自建 mock DOM，需含 #current-user）
│   ├── rule-stress.js      规则匹配语义（17 条组合规则 + 影子匹配器逐行比对）
│   ├── bulk-stress.js      97 词仅标题规则，压 UI 承载
│   ├── performance.js      CLS / 隐藏延迟 / 长任务 / 滚动风暴 / 网络增量
│   ├── spa.js              SPA 路由重建零闪现
│   └── narrow-screen.js    窄屏深测（桌面 UA + 移动 UA 各一遍）
└── fixtures/
    ├── rule-stress.json    rule-stress 的 17 条规则（格式与脚本导出一致）
    └── stress-keywords.txt bulk-stress 的 97 个关键词（逗号分隔）
```

## 环境前提

1. linux.do 已登录（未登录脚本不启动，断言零响应）；
2. 浏览器**不得装有真实 Tampermonkey**（双实例互踩，结果不可信）；广告拦截类扩展会产生噪音，越少越好；
3. 本地服务已启动：`node tests/serve.js`（页面用同步 XHR 从这里拉脚本与测试源码，保证 eval 在同步栈内）。

## 注入模式（每套相同）

1. 预置（如有）：视口模拟 → 刷新 → 等页面就绪（约 5s，30 行帖子出现）；
2. 注入（一次 `evaluate_script`，函数体**纯同步、无 await**）：

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
  // 部分套件另需前置变量（见下表）
  (0, eval)(get('http://127.0.0.1:8123/tests/suites/<对应套件>.js'));
  return 'started';
};
```

3. 轮询：短间隔多次 `evaluate_script` 读结果标志（每次 sleep ≤ 25s，工具级超时约 30s）。

**CSP 硬约束**：脚本在每份文档只允许 eval 一次，且必须发生在 evaluate 的同步栈内；await 之后的定时器回调里 eval 会被站点 CSP（无 `unsafe-eval`）拦截。等待就绪的 sleep 放在独立的 evaluate 调用里。

## 各套件差异

| 套件             | 预置                                                        | 前置变量                                                    | 结果标志                                               |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| console.js       | 无                                                          | 无                                                          | `__lkcbTestResults`（`__lkcbTestsRunning` 为结束标志） |
| rule-stress.js   | 刷新后停在 /latest                                          | `__LKCB_RULE_STRESS__` = rule-stress.json 原文              | `__lkcbRuleStressResults`                              |
| bulk-stress.js   | 无                                                          | `__LKCB_STRESS_KEYWORDS__` = stress-keywords.txt 按逗号切分 | `__lkcbStressResults`                                  |
| performance.js   | 刷新后停在 /latest                                          | 无                                                          | `__lkcbPerfResults`（附 `__lkcbPerfStage`）            |
| spa.js           | 刷新后停在 /latest（页内自点路由标签）                      | 无                                                          | `__lkcbSpaResults`                                     |
| narrow-screen.js | emulate 视口 → 刷新 → 运行；桌面/移动 UA 各一遍，测完清模拟 | 无                                                          | `__lkcbNarrowResults`                                  |

rule-stress 与 bulk-stress 分工：前者压匹配语义（影子匹配器独立重算每行期望，断言不依赖信息流内容），后者压 UI 承载。fixtures 分类 ID（4=开发调优、11=搞七捻三、14=资源荟萃、35=搞七捻三 Lv1）取自 2026-09 实测，站点改 ID 时需同步。

## MCP 侧增强检查（按需，页内断言之外的第二层）

- `list_console_messages` 过滤 error 并归因：gtm.js/chat 插件的 CSP eval 报错、`ERR_BLOCKED_BY_CLIENT`、Discourse 版本日志均属站点噪音；错误栈含 `lkcb` 或时间点对应注入才算脚本问题；
- `list_network_requests` / `get_network_request`：核对数据接口请求与响应体；
- `performance_start_trace` / `stop_trace`：浏览器级 Core Web Vitals（linux.do 加载超 10s，trace 用 reload:false + 手动交互）；
- `take_screenshot`：面板/抽屉布局目检。

## 清理

- 每套测试自带 try/finally：还原 localStorage、移除注入面板、关闭菜单；
- 跑完刷新页面一次（清掉 eval 注入实例与 data 属性残留）；
- 用过的模拟视口记得清除。
