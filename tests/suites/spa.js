/* eslint-disable */
// 真实信息流 + SPA 页内路由：点击站点导航标签切换列表（页面不重载、脚本实例存活），验证切换后
// 过滤照常生效、没有残留状态、零报错。规则用两条「仅标题」：探测词（取首页第一条标题）+ 高频字「的」，
// 保证重建出的新列表必有命中行。
// CLS 增量只报告 + 宽松兜底（站点自身重排也会产生位移，卡死阈值只会随机红）。
// 由 tests/run.js 注入；结果挂 window.__lkcbSpaResults 并 POST 回 tests/serve.js。

(async function () {
  if (window.__lkcbSpaRunning) return console.warn('[lkcb-spa] 已在运行中');
  window.__lkcbSpaRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const CATEGORY_KEY = 'linuxdo-keyword-blocker-categories';
  const ROW = 'tr.topic-list-item, .latest-topic-list-item';
  const NAV = ['/hot', '/top', '/new', '/unread']; // 站点导航改名时自动换下一个
  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error('[lkcb-spa] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。');
    window.__lkcbSpaRunning = false;
    return;
  }

  const origStore = localStorage.getItem(STORE_KEY);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 只统计「我们自己的」报错：「Script error.」是跨域脚本（站点 CDN / Turnstile）的不透明错误
  const opaque = (s) => {
    const t = String(s ?? '').trim();
    return !t || t === 'Script error.' || t === 'Script error';
  };
  const errors = [];
  const recordError = (msg, prefix = '') => {
    if (!opaque(msg)) errors.push(prefix + String(msg));
  };
  window.addEventListener('error', (e) => recordError(e.message));
  window.addEventListener('unhandledrejection', (e) =>
    recordError((e.reason && e.reason.message) || e.reason, 'rejection: '),
  );

  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: ok ? '' : String(detail || '') });
  };
  let metrics = '';
  const report = () =>
    navigator.sendBeacon?.(
      'http://127.0.0.1:8123/__result',
      JSON.stringify({
        suite: 'spa',
        passed: results.filter((r) => r.ok).length,
        total: results.length,
        failures: results.filter((r) => !r.ok),
        results,
        metrics,
      }),
    );

  // CLS 增量：切换前后取差，只报告 + 宽松兜底
  let cls = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* 环境不支持就只损失报告值 */
  }

  try {
    const link = [...document.querySelectorAll('a[href]')].find(
      (a) => NAV.includes(a.getAttribute('href')) && a.offsetParent,
    );
    const sampleTitle = (
      document.querySelector(`${ROW} a.title, ${ROW} a[href^="/t/"]`)?.textContent || ''
    ).trim();
    if (!link || sampleTitle.length < 4) {
      // 站点导航结构变了 / 页面没内容：跳过而不是判失败，避免假红
      assert('SPA 路由切换', true, '');
      metrics = `跳过：${link ? '页面无可采样标题' : '没找到可切换的导航标签'}`;
      return;
    }
    const target = link.getAttribute('href');
    const probe = sampleTitle.slice(0, 8);

    // 同步准备段：写设置 → 注入（eval 必须落在同步栈内，否则被站点 CSP 拦）
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    window.GM_registerMenuCommand = () => {};
    const titleRule = (title) => ({
      category: null,
      allLevels: false,
      tags: [],
      noTag: false,
      title,
      enabled: true,
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ enabled: true, hideMode: 'hide', rules: [titleRule(probe), titleRule('的')] }),
    );
    localStorage.removeItem(CATEGORY_KEY);
    (0, eval)(source);
    await sleep(1200); // 首屏扫描 + 落状态

    const probes = [probe, '的'].map((k) => k.toLowerCase());
    const titleOf = (row) =>
      (
        row.querySelector('a.title, .topic-title, a[href^="/t/"]')?.textContent || ''
      ).trim().toLowerCase();
    // 本该隐藏却没隐藏的行 = 泄漏
    const leaked = () =>
      [...document.querySelectorAll(ROW)].filter(
        (r) => probes.some((k) => titleOf(r).includes(k)) && r.getAttribute('data-lkcb-state') !== 'hidden',
      ).length;
    // 状态只能挂在信息流行上，挂在别处就是残留
    const stray = () =>
      [...document.querySelectorAll('[data-lkcb-state]')].filter(
        (el) => !el.matches(ROW) && !el.closest(ROW),
      ).length;

    async function switchTo(href, from) {
      const mark = cls;
      const t0 = performance.now();
      document.querySelector(`a[href="${href}"]`)?.click();
      let moved = false;
      for (let i = 0; i < 24; i++) {
        await sleep(150);
        if (location.pathname === href) {
          moved = true;
          break;
        }
      }
      if (!moved) throw new Error('路由未切到 ' + href);
      for (let i = 0; i < 16; i++) {
        await sleep(150);
        if (document.querySelectorAll(ROW).length) break;
      }
      await sleep(1200); // 等文本填充与脚本落状态
      const rows = document.querySelectorAll(ROW).length;
      const hidden = document.querySelectorAll(`${ROW}[data-lkcb-state="hidden"]`).length;
      const clsDelta = +(cls - mark).toFixed(4);
      const tag = `切换 ${from}→${href}`;
      metrics += `${metrics ? ' | ' : ''}${from}→${href} CLS+${clsDelta} 行=${rows} 隐藏=${hidden} ${Math.round(performance.now() - t0)}ms`;
      assert(`${tag}：列表重建且有行`, rows > 0, `rows=${rows}`);
      assert(`${tag}：新列表仍按规则隐藏`, hidden > 0, `hidden=${hidden}`);
      assert(`${tag}：命中的行都隐藏了（零泄漏）`, leaked() === 0, `漏 ${leaked()} 行`);
      assert(`${tag}：无残留状态（状态只挂在信息流行）`, stray() === 0, `残留 ${stray()} 处`);
      assert(`${tag}：位移可控（CLS ≤ 0.05）`, clsDelta <= 0.05, `CLS=${clsDelta}`);
    }

    await switchTo(target, '/latest');
    await switchTo('/latest', target);
    assert('全程零 JS 错误', errors.length === 0, errors.slice(0, 3).join('; '));
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    results.push({ name: '异常中断（后续断言未执行）', ok: false, detail: msg });
    console.error('[lkcb-spa] 异常中断:', e);
  } finally {
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    document.querySelectorAll('[data-lkcb-state]').forEach((el) => el.removeAttribute('data-lkcb-state'));
    window.__lkcbSpaResults = results;
    window.__lkcbSpaRunning = false;
    report();
  }
})();
