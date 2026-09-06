/* eslint-disable */
// ============================================================================
// Linux.do Keyword Blocker — 性能测试（浏览器控制台运行，linux.do /latest 页面，已登录）
// ============================================================================
//
// 【运行前提】
//   1. 页面已刷新、停留在 /latest 列表页且已登录；
//   2. 先注入：window.__LKCB_SOURCE__ = `<ld-blocker.user.js 完整内容>`。
//
// 【关键约束】被测脚本只允许 eval 一次，且必须在首个 await 之前的同步段执行：
//   定时器回调（await 之后的异步延续）里的 eval 会被站点 CSP 拦截
//   （script-src 'nonce-…' 'strict-dynamic'，无 'unsafe-eval'）。
//   因此本文件把「采样标题 → 写设置 → eval 注入」全部放在同步段，
//   与 console-tests.js / stress-test.js 的注入模式一致。
//
// 【监控手段】（本环境无 CDP 抓包，用 Performance API 等价替代；
//   如需报文级抓包，用真实 Chrome 的 DevTools Network 面板手动核对）
//   1. CLS：PerformanceObserver(layout-shift, buffered) 累计布局偏移分数；
//      页面加载期的历史偏移由 buffered 条目补发，基线在注入后、风暴前截取；
//   2. 长任务：PerformanceObserver(longtask) 记录 >50ms 的主线程阻塞；
//   3. 隐藏延迟：配对 MutationObserver——行插入时间戳 vs data-lkcb-state
//      出现时间戳，差值即「新行从插入到被隐藏」的真实延迟。站点的无限滚动
//      在合成滚动下不稳定，自然新行不保证命中，因此风暴后追加确定性探针：
//      克隆已隐藏行、剥掉状态标记、重新插回表格——走同一条
//      「观察器 → 匹配 → 打标记」生产管线，保证有样本可测；
//   4. 网络请求量：Resource Timing 统计滚动加载期间的请求数与传输字节数增量
//      （Discourse 无限滚动靠 XHR 拉取 topics.json/message-bus）。
//
// 【流程】同步段：监控 + 探测词采样 + 注入 → 基线期 900ms → 滚动风暴
//   （12 轮 × 1500px，合成 wheel 事件 + scrollBy，触发无限滚动）
//   → 隐藏延迟探针（克隆隐藏行插回 ×10）→ 汇总。
// 【输出】window.__lkcbPerfResults：风暴期 CLS 增量、隐藏延迟 avg/max、
//   长任务、网络请求增量、最终行数/隐藏数、JS 错误。
// ============================================================================

(async function () {
  if (window.__lkcbPerfRunning) return console.warn('[lkcb-perf] 已在运行中');
  window.__lkcbPerfRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error('[lkcb-perf] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。');
    window.__lkcbPerfRunning = false;
    return;
  }

  const origStore = localStorage.getItem(STORE_KEY);
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) =>
    pageErrors.push('rejection: ' + String(e.reason?.message || e.reason)),
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let out = null;
  let rowObs = null;
  let attrObs = null;
  window.__lkcbPerfStage = 'setup';
  try {
    // —— 监控 1：CLS（buffered 会补发页面加载期的历史条目） ——
    const cls = { total: 0, max: 0, count: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        cls.total += e.value;
        cls.max = Math.max(cls.max, e.value);
        cls.count++;
      }
    }).observe({ type: 'layout-shift', buffered: true });

    // —— 监控 2：长任务 ——
    const longtasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          longtasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) {
      /* 部分环境不支持 longtask */
    }

    // —— 监控 3：隐藏延迟（行插入 → data-lkcb-state 出现） ——
    const insertTimes = new Map();
    rowObs = new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes)
          if (n.nodeType === 1 && n.matches?.('tr.topic-list-item'))
            insertTimes.set(n, performance.now());
    });
    rowObs.observe(document.body, { childList: true, subtree: true });
    const latencies = [];
    attrObs = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = insertTimes.get(m.target);
        if (t && m.attributeName === 'data-lkcb-state') {
          latencies.push(Math.round(performance.now() - t));
          insertTimes.delete(m.target);
        }
      }
    });
    attrObs.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-lkcb-state'],
      subtree: true,
    });

    // —— 同步准备段：采样探测词 → 写设置 → 注入（必须保持在首个 await 之前） ——
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
      registerMenuCommand: () => {},
    };
    // Resource Timing 默认缓冲区只有 250 条，长会话早已写满会导致网络增量为 0
    performance.setResourceTimingBufferSize(2000);
    window.__lkcbPerfStage = 'prep';

    const sampleTitle = (
      document.querySelector('tr.topic-list-item a.title, tr.topic-list-item a[href^="/t/"]')
        ?.textContent || ''
    ).trim();
    const probeWord = sampleTitle.slice(0, 8);
    if (probeWord.length < 4) {
      out = { skipped: '页面无可采样标题，无法保证确定性命中', sampleTitle };
      console.error('[lkcb-perf]', out.skipped);
      return;
    }

    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        enabled: true,
        hideMode: 'hide',
        // 两个关键词各司其职：探测词保证基线确定性命中；高频字「的」命中
        // 风暴中新加载的绝大多数中文标题，压「大量行即时隐藏」的最坏情况，
        // 并让隐藏延迟（只有命中行才会打 data-lkcb-state）有样本可测
        keywords: [probeWord, '的'],
      }),
    );
    window.__lkcbPerfStage = 'eval';
    (0, eval)(source);
    window.__lkcbPerfStage = 'post-eval';

    // —— 基线期：等 buffered 的 CLS 历史条目补发完，再截取风暴前基线 ——
    await sleep(900);
    window.__lkcbPerfStage = 'baseline';
    const clsAtStorm = cls.total;
    const rowsBefore = document.querySelectorAll('tr.topic-list-item').length;
    const hiddenBefore = document.querySelectorAll(
      'tr.topic-list-item[data-lkcb-state="hidden"]',
    ).length;
    const netBefore = performance.getEntriesByType('resource').length;
    const netBytesBefore = performance
      .getEntriesByType('resource')
      .reduce((s, r) => s + (r.transferSize || 0), 0);
    const t0 = performance.now();

    // —— 滚动风暴：12 轮 × 1500px，触发无限滚动 ——
    // 站点的加载器监听 wheel 事件，纯程序化 scrollBy 不会触发加载，
    // 因此每轮先派发合成滚轮事件再滚动（等效真实用户滚动）
    window.__lkcbPerfStage = 'storm';
    const perRound = [];
    for (let i = 0; i < 12; i++) {
      window.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 1500, bubbles: true, cancelable: true }),
      );
      window.scrollBy(0, 1500);
      await sleep(600);
      perRound.push({
        round: i + 1,
        rows: document.querySelectorAll('tr.topic-list-item').length,
        hidden: document.querySelectorAll('tr.topic-list-item[data-lkcb-state="hidden"]')
          .length,
      });
    }
    await sleep(800);

    // —— 隐藏延迟探针：克隆已隐藏行，剥掉状态标记后插回表格 ——
    // 每次插入都是真实 DOM 插入，走「观察器 → 匹配（缓存命中）→ 打标记」
    // 生产管线；行应在绘制前被打上 display:none——探针期 CLS≈0 即为无闪现的证明
    window.__lkcbPerfStage = 'probe';
    const clsAtProbe = cls.total;
    const srcRow = document.querySelector(
      'tr.topic-list-item[data-lkcb-state="hidden"]',
    );
    if (srcRow) {
      const tbody = srcRow.parentElement;
      for (let i = 0; i < 10; i++) {
        const row = srcRow.cloneNode(true);
        row.removeAttribute('data-lkcb-state');
        row.removeAttribute('data-lkcb-match');
        tbody.appendChild(row);
        await sleep(200);
      }
      await sleep(500);
    }

    // —— 汇总 ——
    const resources = performance.getEntriesByType('resource');
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    out = {
      probeWord,
      sampleTitle: sampleTitle.slice(0, 30),
      cls: {
        // 风暴期 = 注入基线到探针开始；探针期 ≈0 证明插入行在绘制前已被隐藏
        stormAttributable: +(clsAtProbe - clsAtStorm).toFixed(4),
        probeAttributable: +(cls.total - clsAtProbe).toFixed(4),
        maxShift: +cls.max.toFixed(4),
        shifts: cls.count,
      },
      hideLatencyMs: {
        count: latencies.length,
        avg,
        max: latencies.length ? Math.max(...latencies) : null,
        note: '行插入到被标记隐藏的真实延迟；本版为毫秒级（旧版 300ms 防抖时 >1200ms）',
      },
      longtasks: { count: longtasks.length, durationsMs: longtasks },
      network: {
        // Resource Timing 替代抓包：滚动期间的请求增量与传输字节数
        requestsDelta: resources.length - netBefore,
        transferBytesDelta: resources.reduce((s, r) => s + (r.transferSize || 0), 0) - netBytesBefore,
      },
      scroll: {
        rowsBefore,
        rowsAfter: document.querySelectorAll('tr.topic-list-item').length,
        hiddenBefore,
        hiddenAfter: document.querySelectorAll('tr.topic-list-item[data-lkcb-state="hidden"]')
          .length,
        perRound,
        elapsedMs: Math.round(performance.now() - t0),
      },
      pageErrors,
    };
    window.__lkcbPerfStage = 'summary';
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    out = out || { stage: window.__lkcbPerfStage, error: msg };
    console.error('[lkcb-perf] 异常中断 @', window.__lkcbPerfStage, e);
  } finally {
    // —— 清理：无论成败都还原存储与行状态 ——
    document.getElementById('lkcb-float')?.remove();
    rowObs?.disconnect();
    attrObs?.disconnect();
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    document
      .querySelectorAll('[data-lkcb-state],[data-lkcb-match]')
      .forEach((el) => {
        el.removeAttribute('data-lkcb-state');
        el.removeAttribute('data-lkcb-match');
      });
    window.__lkcbPerfStage = 'done';
  }

  console.log(
    out && !out.error
      ? '%c[lkcb-perf] 完成'
      : '%c[lkcb-perf] 异常中断（详见输出的 error/stage 字段）',
    'font-weight:bold;color:' + (out && !out.error ? 'green' : 'red'),
  );
  console.log(JSON.stringify(out, null, 2));
  window.__lkcbPerfResults = out;
  window.__lkcbPerfRunning = false;
})();
