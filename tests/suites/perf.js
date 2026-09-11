/* eslint-disable */
// 性能与抖动回归：在被测脚本之前装好取证设施，加载 27 条真实规则集后滚动加载多页。
// 处理模式由 run.js 通过 window.__LKCB_PERF_MODE__ 传进来（dim / hide），两种模式各跑一遍。
// 断言（名字带 [淡化] / [隐藏] 前缀）：
//   1) 首屏同一行状态只写一次（不反复跳）
//   2) 稳定后已存在的行不再被重写状态（不重新算来算去）
//   3) observer 单次回调 ≤ 250ms、累计 ≤ 2000ms（patch MutationObserver 计 handleAddedNodes）
//   4) 全程无脚本自身的 JS 报错
//   5) 全过程每行状态只写一次；滚动加载期间 CLS ≤ 0.01
// 只报告不判定：CLS 首屏（隐藏模式把行摘掉，必然位移）与「内容到达 → 状态落地」的延迟分位数，
// 都由站点自身渲染 / hydration 决定，卡阈值只会随机红（原因见 AGENTS.md）。
// 结果挂 window.__lkcbPerfResults（__lkcbPerfRunning 为结束标志），并 POST 回 tests/serve.js。
// 规则集来自 tests/fixtures/rules-sample.json；由 tests/run.js 注入，页面已登录、专用 profile 无扩展。

(async function () {
  if (window.__lkcbPerfRunning) return console.warn('[lkcb-perf] 已在运行中');
  window.__lkcbPerfRunning = true;

  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error(
      '[lkcb-perf] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。',
    );
    window.__lkcbPerfRunning = false;
    return;
  }

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const CATEGORY_KEY = 'linuxdo-keyword-blocker-categories';
  const SEL =
    '.fps-result, .latest-topic-list-item, .topic-list-item, [data-topic-id]';
  // 处理模式由 run.js 传进来：两种模式都要量（隐藏会移除行、淡化只调透明度，布局行为不同）
  const mode = window.__LKCB_PERF_MODE__ === 'hide' ? 'hide' : 'dim';
  const tag = mode === 'hide' ? '隐藏' : '淡化';
  const origStore = localStorage.getItem(STORE_KEY);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const failures = [];
  const assert = (rawName, ok, detail) => {
    const name = `[${tag}] ${rawName}`;
    results.push({ name, ok: !!ok, detail: ok ? '' : String(detail || '') });
    if (!ok) failures.push(name);
  };
  // 结果推回本地 serve.js（落盘 + 一行摘要）：看结果不必再把全量断言数组搬回来
  let metrics = ''; // 关键指标，跟着结果一起推回去，通过时也能看到余量
  const report = () =>
    navigator.sendBeacon?.(
      'http://127.0.0.1:8123/__result',
      JSON.stringify({
        suite: 'perf-' + mode,
        passed: results.filter((r) => r.ok).length,
        total: results.length,
        failures: results.filter((r) => !r.ok),
        results, // 全量明细只落盘 tests/.last-result.json，终端只打一行摘要
        metrics,
      }),
    );
  // 只统计「我们自己的」报错：「Script error.」是不透明错误，只有跨域脚本（站点 CDN / Turnstile）才会长这样；
  // 我们注入的脚本不是跨域，真报错必然带真实 message
  const errors = [];
  const opaque = (s) => {
    const t = String(s ?? '').trim();
    return !t || t === 'Script error.' || t === 'Script error';
  };
  const recordError = (msg, prefix = '') => {
    if (!opaque(msg)) errors.push(prefix + String(msg));
  };
  window.addEventListener('error', (e) => recordError(e.message));
  window.addEventListener('unhandledrejection', (e) =>
    recordError((e.reason && e.reason.message) || e.reason, 'rejection: '),
  );

  // —— 取证设施必须在 eval 被测脚本之前装好 ——
  const obsStats = [];
  const writes = []; // 每次 data-lkcb-state 的写入（含元素引用与时间）
  const firstSeen = new WeakMap(); // 元素首次作为新增节点出现的时间
  const contentAt = new WeakMap(); // 行内容最后到达的时间（站点往行里插文本节点）
  const OrigMO = window.MutationObserver;
  window.MutationObserver = class extends OrigMO {
    constructor(cb) {
      super(function (muts, obs) {
        if (cb && cb.name === 'handleAddedNodes') {
          const t = performance.now();
          try {
            cb(muts, obs);
          } catch (e) {
            errors.push('observer 回调抛错: ' + (e && e.message)); // 脚本自己的异常，一定算数
          }
          obsStats.push({ ms: performance.now() - t });
          return;
        }
        cb(muts, obs);
      });
    }
  };
  const attrMo = new OrigMO((muts) => {
    for (const m of muts)
      writes.push({
        el: m.target,
        t: performance.now(),
        state: m.target.getAttribute('data-lkcb-state') || '',
      });
  });
  attrMo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-lkcb-state'],
    subtree: true,
  });
  const seenMo = new OrigMO((muts) => {
    const now = performance.now();
    for (const m of muts)
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (!firstSeen.has(n)) firstSeen.set(n, now);
        } else if (n.nodeType === 3 && n.parentElement) {
          // 站点填内容 = 往行里插文本节点，记下宿主行的「内容到达」时刻
          const host = n.parentElement.closest(SEL);
          if (host) contentAt.set(host, now);
        }
      }
  });
  seenMo.observe(document.documentElement, { childList: true, subtree: true });

  let cls = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {
    /* 环境不支持时只损失报告值 */
  }

  try {
    const get = (url) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, false);
      x.send(null);
      if (x.status !== 200) throw new Error('fetch fail ' + url);
      return x.responseText;
    };
    const sample = JSON.parse(
      get('http://127.0.0.1:8123/tests/fixtures/rules-sample.json'),
    );
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ enabled: true, hideMode: mode, rules: sample }),
    );
    localStorage.removeItem(CATEGORY_KEY); // 强制走网络，覆盖「类别树就绪」门控
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    window.GM_registerMenuCommand = () => {};

    const t0 = performance.now();
    (0, eval)(source); // CSP：必须落在同步栈内

    await sleep(3200); // 首屏渲染 + 类别树就绪
    const tFirst = performance.now();
    const clsFirst = cls;
    const firstRows = new Set(document.querySelectorAll(SEL));
    const firstWrites = writes.filter((w) => w.t - t0 < 3200);
    const perRow = new Map();
    for (const w of firstWrites) perRow.set(w.el, (perRow.get(w.el) || 0) + 1);
    const firstMaxWrites = Math.max(0, ...perRow.values());

    for (let i = 0; i < 6; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
    }
    await sleep(1500);

    // 滚动前就存在的行若又被写状态，就是「过一会儿又跳一下」
    const rewrites = writes.filter((w) => w.t >= tFirst && firstRows.has(w.el));
    const delays = writes
      .filter((w) => w.t >= tFirst && !firstRows.has(w.el))
      .map((w) => {
        const arrived = contentAt.get(w.el);
        const base = arrived !== undefined ? arrived : firstSeen.get(w.el);
        return base !== undefined ? w.t - base : -1;
      })
      .filter((v) => v >= 0)
      .sort((a, b) => a - b);
    const p95 = delays.length ? delays[Math.floor(delays.length * 0.95)] : 0;
    const allPerRow = new Map();
    for (const w of writes) allPerRow.set(w.el, (allPerRow.get(w.el) || 0) + 1);
    const allMaxWrites = Math.max(0, ...allPerRow.values());

    const obsMs = obsStats.map((s) => s.ms);
    const obsTotal = +obsMs.reduce((a, b) => a + b, 0).toFixed(1);
    const obsMax = obsMs.length ? +Math.max(...obsMs).toFixed(1) : 0;

    assert(
      '首屏：同一行状态最多写一次（不反复跳）',
      firstMaxWrites <= 1,
      `max=${firstMaxWrites} 写入 ${firstWrites.length} 次`,
    );
    assert(
      '稳定后：已存在的行不再被重写状态（不重新算来算去）',
      rewrites.length === 0,
      `重写 ${rewrites.length} 次`,
    );
    assert(
      '脚本 observer 单次回调 ≤ 250ms',
      obsMax <= 250,
      `max=${obsMax}ms callbacks=${obsMs.length}`,
    );
    assert(
      '脚本 observer 累计耗时 ≤ 2000ms（300 行滚动加载）',
      obsTotal <= 2000,
      `total=${obsTotal}ms`,
    );
    assert(
      '全程无 JS 错误',
      errors.length === 0,
      errors.slice(0, 3).join('; '),
    );
    assert(
      '全过程每行状态只写一次（没有反复跳）',
      allMaxWrites <= 1,
      `max=${allMaxWrites}`,
    );
    const clsScroll = cls - clsFirst;
    assert(
      '滚动加载期间布局偏移 CLS ≤ 0.01（不抖动）',
      clsScroll <= 0.01,
      `CLS滚动=${clsScroll.toFixed(4)}`,
    );
    // 「站点插入内容 → 我们写上状态」只报告不判定：同一份代码实测 p95 在 15～230ms 之间跳，
    // 这段时间主要被站点自身的渲染 / hydration 长任务占着，脚本控制不了；脚本自身的开销由上面几条断言守
    const at = (q) =>
      delays.length
        ? delays[Math.min(delays.length - 1, Math.floor(delays.length * q))]
        : 0;
    metrics =
      `延迟p50=${at(0.5).toFixed(0)} p95=${p95.toFixed(0)} max=${(delays[delays.length - 1] || 0).toFixed(0)}ms n=${delays.length}` +
      ` 回调${obsMs.length}次/最长${obsMax}ms/总${obsTotal}ms CLS首屏=${clsFirst.toFixed(4)} CLS滚动=${clsScroll.toFixed(4)} 写入=${allMaxWrites}`;
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    results.push({
      name: '异常中断（后续断言未执行）',
      ok: false,
      detail: msg,
    });
    failures.push('异常中断');
    console.error('[lkcb-perf] 异常中断:', e);
  } finally {
    attrMo.disconnect();
    seenMo.disconnect();
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    const passed = results.filter((r) => r.ok).length;
    console.log(
      '%c[lkcb-perf] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    report();
    window.__lkcbPerfResults = results;
    window.__lkcbPerfRunning = false;
  }
})();
