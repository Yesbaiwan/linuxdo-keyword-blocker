/* eslint-disable */
// SPA 路由重建零闪现：真实点击「热门/最新」路由标签，验证过滤照常生效、每次切换 CLS 增量=0、零泄漏、零报错。
// 结果挂 window.__lkcbSpaResults。

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
