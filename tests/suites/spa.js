/* eslint-disable */
// ============================================================================
// Linux.do Keyword Blocker — SPA 路由重建零闪现测试（Chrome DevTools MCP 驱动，
// 见 tests/README.md）
// ============================================================================
//
// 【测什么】linux.do 是 Ember 单页应用：切换「最新/热门」等列表路由时，
//   整个帖子列表被拆掉重建，脚本必须靠观察器在绘制前接住所有新行。
//   本测试真实点击路由标签触发重建，验证「重建后零闪现、零泄漏」。
//
// 【运行前提】
//   1. MCP 连接的 Chrome 已登录 linux.do，刷新后停留在任意列表页（/latest 等）；
//   2. 本地服务 node tests/serve.js 已启动；
//   3. 按tests/README.md 的通用注入模式拉取并 eval 本文件（同步栈内）。
//
// 【关键约束】脚本只允许 eval 一次且必须在首个 await 之前的同步段执行
//   （定时器回调里的 eval 会被站点 CSP 拦截），与五件套其余测试一致。
//
// 【判定项】
//   1. 两次路由切换（/latest → /hot → /latest）均完成且新列表有行；
//   2. 重建后的列表中被屏蔽行数 > 0（新列表里过滤照常生效）；
//   3. 每次切换的 CLS 增量 ≈ 0 —— 行未绘制即被隐藏的硬证据（有闪现必产生位移）；
//   4. 泄漏 = 0：标题命中规则却无隐藏标记的行数；
//   5. 隐藏延迟（行插入 → data-lkcb-state 出现）：信息项，只报告不判定——
//      新行常以骨架先插入、文本后填充，延迟含文本填充时间，CLS 才是闪现的权威指标；
//   6. 全程零 JS 错误。
//
// 【不做的事】「显示 N 个新的话题」按钮场景（停留时站点实时来新帖）不自动化：
//   按钮只在恰好有人发帖时出现，无法确定性触发；其底层插入管线与本测试的
//   路由重建及 performance-test 的探针完全同源，已被等效覆盖。遇到了手动点一下即可。
//
// 【输出】window.__lkcbSpaResults；结束后自动恢复原始设置并清理。
// ============================================================================

(async function () {
  if (window.__lkcbSpaRunning) return console.warn('[lkcb-spa] 已在运行中');
  window.__lkcbSpaRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error(
      '[lkcb-spa] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。',
    );
    window.__lkcbSpaRunning = false;
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
  window.__lkcbSpaStage = 'setup';

  try {
    // —— 监控 1：CLS（buffered 补发页面加载期历史，切换前另取基准） ——
    const cls = { total: 0, max: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        cls.total += e.value;
        cls.max = Math.max(cls.max, e.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });

    // —— 监控 2：隐藏延迟配对（行插入 → data-lkcb-state 出现） ——
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

    // —— 同步准备段：采样探测词 → 写设置 → 注入（保持同步，约束见文件头） ——
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    window.__lkcbSpaStage = 'prep';

    const sampleTitle = (
      document.querySelector(
        'tr.topic-list-item a.title, tr.topic-list-item a[href^="/t/"]',
      )?.textContent || ''
    ).trim();
    const probeWord = sampleTitle.slice(0, 8);
    if (probeWord.length < 4) {
      out = { skipped: '页面无可采样标题', sampleTitle };
      return;
    }
    // 探测词保证基线命中；高频字「的」保证重建出的新列表必有大量命中行
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        enabled: true,
        hideMode: 'hide',
        rules: [probeWord, '的'].map((k) => ({
          category: null,
          tag: '',
          title: k,
        })),
      }),
    );
    window.__lkcbSpaStage = 'eval';
    (0, eval)(source);
    window.__lkcbSpaStage = 'post-eval';
    await sleep(800); // 初始全量扫描完成

    const results = [];
    const assert = (name, cond, detail) => {
      results.push({ name, ok: !!cond, detail: String(detail || '') });
    };
    const info = (name, value) => {
      results.push({ name, ok: true, detail: String(value) });
    };

    // 真实点击路由标签（Ember 拦截点击做页内切换，页面不重载、脚本存活）
    async function switchRoute(href) {
      const link = document.querySelector(`#navigation-bar a[href="${href}"]`);
      if (!link) throw new Error('找不到路由标签: ' + href);
      const clsMark = cls.total;
      const latMark = latencies.length;
      const t0 = performance.now();
      link.click();
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        if (location.pathname === href) break;
      }
      if (location.pathname !== href) throw new Error('路由未切换到 ' + href);
      for (let i = 0; i < 12; i++) {
        await sleep(150);
        if (document.querySelectorAll('tr.topic-list-item').length > 0) break;
      }
      await sleep(1000); // 等 Ember 文本填充与脚本隐藏稳定
      return {
        clsDelta: +(cls.total - clsMark).toFixed(4),
        latencySamples: latencies.length - latMark,
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    // —— 切换 1：/latest → /hot ——
    window.__lkcbSpaStage = 'route-hot';
    const r1 = await switchRoute('/hot');
    r1.route = '/latest → /hot';
    r1.rows = document.querySelectorAll('tr.topic-list-item').length;
    r1.hidden = document.querySelectorAll(
      'tr.topic-list-item[data-lkcb-state="hidden"]',
    ).length;
    results.push({
      name: '切换 /hot：路由完成且新列表有行',
      ok: r1.rows > 0,
      detail: 'rows=' + r1.rows,
    });
    results.push({
      name: '切换 /hot：重建列表中被屏蔽行 > 0',
      ok: r1.hidden > 0,
      detail: 'hidden=' + r1.hidden,
    });
    info('切换 /hot：CLS 增量（0 = 绘制前隐藏，无闪现）', r1.clsDelta);
    info('切换 /hot：隐藏延迟样本数', r1.latencySamples);

    // —— 切换 2：/hot → /latest ——
    window.__lkcbSpaStage = 'route-latest';
    const r2 = await switchRoute('/latest');
    r2.route = '/hot → /latest';
    r2.rows = document.querySelectorAll('tr.topic-list-item').length;
    r2.hidden = document.querySelectorAll(
      'tr.topic-list-item[data-lkcb-state="hidden"]',
    ).length;
    results.push({
      name: '切换 /latest：路由完成且新列表有行',
      ok: r2.rows > 0,
      detail: 'rows=' + r2.rows,
    });
    results.push({
      name: '切换 /latest：重建列表中被屏蔽行 > 0',
      ok: r2.hidden > 0,
      detail: 'hidden=' + r2.hidden,
    });
    info('切换 /latest：CLS 增量（0 = 绘制前隐藏，无闪现）', r2.clsDelta);
    info('切换 /latest：隐藏延迟样本数', r2.latencySamples);

    // 判定：两次切换的布局位移都必须接近零（阈值 0.005，站点自身基线 ~0.0003）
    assert(
      '零闪现：两次切换 CLS 增量均 ≤ 0.005',
      r1.clsDelta <= 0.005 && r2.clsDelta <= 0.005,
      'hot=' + r1.clsDelta + ' latest=' + r2.clsDelta,
    );

    // —— 泄漏检查：命中标题规则的行却没被隐藏 ——
    // 与脚本同口径：仅标题字段包含匹配（本测试注入的均为仅标题规则）
    window.__lkcbSpaStage = 'leak-check';
    const probes = [probeWord, '的'].map((k) => k.toLowerCase());
    const leakDetails = [];
    document.querySelectorAll('tr.topic-list-item').forEach((row) => {
      const title = (
        row.querySelector('.title, a.title, .raw-topic-link')?.textContent || ''
      )
        .trim()
        .toLowerCase();
      if (
        probes.some((k) => title.includes(k)) &&
        row.getAttribute('data-lkcb-state') !== 'hidden' &&
        leakDetails.length < 3
      ) {
        leakDetails.push(title.slice(0, 24));
      }
    });
    assert(
      '零泄漏：命中标题规则的行全部隐藏',
      leakDetails.length === 0,
      leakDetails.join(' | ') || 'leaks=0',
    );

    // —— 隐藏延迟汇总（信息项） ——
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    info(
      '隐藏延迟 avg/max ms（样本数 ' + latencies.length + '）',
      avg + ' / ' + (latencies.length ? Math.max(...latencies) : '-'),
    );

    assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));

    out = {
      probeWord,
      transitions: [r1, r2],
      clsTotal: +cls.total.toFixed(4),
      hideLatencyMs: {
        count: latencies.length,
        avg,
        max: latencies.length ? Math.max(...latencies) : null,
      },
      leaks: leakDetails,
      assertions: results,
      pageErrors,
    };
    window.__lkcbSpaStage = 'done';

    const failed = results.filter((r) => !r.ok);
    console.log(
      '%c[lkcb-spa] ' +
        (results.length - failed.length) +
        '/' +
        results.length +
        ' 通过',
      'font-weight:bold;color:' + (failed.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log(
        (r.ok ? '✅ ' : '❌ ') +
          i +
          '. ' +
          r.name +
          (r.ok ? '' : ' —— ' + r.detail),
      ),
    );
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    out = out || { stage: window.__lkcbSpaStage, error: msg };
    console.error('[lkcb-spa] 异常中断 @', window.__lkcbSpaStage, e);
  } finally {
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
    window.__lkcbSpaResults = out;
    window.__lkcbSpaRunning = false;
  }
})();
