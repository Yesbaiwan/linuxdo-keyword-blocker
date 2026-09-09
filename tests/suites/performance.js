/* eslint-disable */
// 性能压测：CLS、隐藏延迟（探针期 CLS≈0 才是「绘制前隐藏」权威证明，延迟均值属 Ember 骨架节奏仅参考）、
// 长任务（站点自身也有 ~3s 长任务）、滚动风暴（合成 wheel + scrollBy）、网络增量（开头需 setResourceTimingBufferSize 扩容）。
// 结果挂 window.__lkcbPerfResults（附 __lkcbPerfStage）。

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
        // 两条仅标题规则各司其职：探测词保证基线确定性命中；高频字「的」命中
        // 风暴中新加载的绝大多数中文标题，压「大量行即时隐藏」的最坏情况，
        // 并让隐藏延迟（只有命中行才会打 data-lkcb-state）有样本可测
        rules: [probeWord, '的'].map((k) => ({ category: null, tag: '', title: k })),
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
