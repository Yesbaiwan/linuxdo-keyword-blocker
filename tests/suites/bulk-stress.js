/* eslint-disable */
// 海量仅标题规则压 UI 承载（97 词来自 fixtures/stress-keywords.txt）：菜单视图渲染/
// 内部滚动/footer 可见/无横向溢出/滚动到底删除/过滤联动。匹配语义由 rule-stress 覆盖。
// 结果挂 window.__lkcbStressResults。

(async function () {
  if (window.__lkcbStressRunning)
    return console.warn('[lkcb-stress] 已在运行中');
  window.__lkcbStressRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  const keywords = window.__LKCB_STRESS_KEYWORDS__;
  if (!source || !Array.isArray(keywords) || keywords.length < 50) {
    console.error(
      '[lkcb-stress] 缺少前置变量：__LKCB_SOURCE__（脚本源码）与 __LKCB_STRESS_KEYWORDS__（海量关键词数组，≥50 个）。',
    );
    window.__lkcbStressRunning = false;
    return;
  }

  const origStore = localStorage.getItem(STORE_KEY);
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) =>
    pageErrors.push('rejection: ' + String(e.reason?.message || e.reason)),
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  let passed = 0;
  const failures = [];
  function assert(name, cond, detail) {
    const ok = !!cond;
    results.push({
      name,
      ok,
      detail: ok
        ? typeof detail !== 'string'
          ? JSON.stringify(detail)
          : detail
        : String(detail || ''),
    });
    if (ok) passed++;
    else failures.push(name);
  }
  // 只记录数字的「信息项」，不参与通过/失败
  function info(name, value) {
    results.push({
      name,
      ok: true,
      detail: typeof value === 'number' ? String(value) : JSON.stringify(value),
    });
  }

  // 滚动区是内部的 #lkcb-rules
  function surfaceChecks() {
    const root = document.querySelector(
      '.panel-body-contents #lkcb-quick-access',
    );
    if (!root) return { exists: false };
    const ul = root.querySelector('#lkcb-rules');
    const footer = root.querySelector('.lkcb-footer');
    const fr = footer.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    return {
      exists: true,
      rows: ul.children.length,
      ulScrollable: ul.scrollHeight > ul.clientHeight,
      footerVisible: fr.bottom <= rr.bottom + 1 && fr.top >= rr.top - 1,
      noHorizOverflow: root.scrollWidth <= root.clientWidth,
      inViewport: root
        .closest('.user-menu.menu-panel')
        .getBoundingClientRect().bottom <= innerHeight,
    };
  }
  // expectedRows：当前应渲染的规则行数
  const surfaceOk = (c, expectedRows) =>
    c.exists &&
    c.rows === expectedRows &&
    c.ulScrollable &&
    c.footerVisible &&
    c.noHorizOverflow &&
    c.inViewport;

  try {
    // —— 准备：海量词转仅标题规则写入 + 注入脚本 ——
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        enabled: true,
        hideMode: 'hide',
        rules: keywords.map((k) => ({ category: null, tag: '', title: k })),
      }),
    );
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    (0, eval)(source);
    await sleep(500);

    // —— A. 头像菜单视图压测 ——
    document.getElementById('toggle-current-user').click();
    await sleep(800);
    const entry = document.getElementById('lkcb-menu-entry');
    assert('头像菜单：入口正常注入', !!entry);
    const t0 = performance.now();
    entry.click();
    await sleep(400);
    const renderMs = Math.round(performance.now() - t0);
    const ma = surfaceChecks();
    assert(
      '菜单视图：海量规则渲染完整且无变形',
      surfaceOk(ma, keywords.length),
      JSON.stringify(ma),
    );
    info('菜单视图渲染耗时 ms', renderMs);

    // 滚动到底删除最后一行仍工作
    await new Promise((resolve) => {
      const ul = document.querySelector('.panel-body-contents #lkcb-rules');
      ul.scrollTop = ul.scrollHeight;
      const before = ul.children.length;
      ul.lastElementChild.querySelector('button.lkcb-remove').click();
      setTimeout(() => {
        assert(
          '菜单视图：滚动到底删除行正常',
          document.querySelectorAll('.panel-body-contents #lkcb-rules li')
            .length ===
            before - 1,
        );
        resolve();
      }, 300);
    });
    document.getElementById('toggle-current-user').click();
    await sleep(400);

    // —— B. 过滤联动：用当前页面真实标题前缀作为标题规则 ——
    // 全程走运行中实例的 UI（重开菜单 → 清空 → 添加探测规则），不重新 eval
    // （页内二次 eval 会被站点 CSP 间歇性拦截）
    const sampleTitle = (
      document.querySelector(
        'tr.topic-list-item a.title, tr.topic-list-item a[href^="/t/"]',
      )?.textContent || ''
    ).trim();
    const probeWord = sampleTitle.slice(0, 8);
    assert('过滤联动：页面存在可采样标题', probeWord.length >= 4, sampleTitle);
    if (probeWord.length >= 4) {
      document.getElementById('toggle-current-user').click();
      await sleep(600);
      document.getElementById('lkcb-menu-entry').click();
      await sleep(400);
      document.getElementById('lkcb-clear').click();
      await sleep(300);
      const titleInput = document.getElementById('lkcb-rule-title');
      titleInput.value = probeWord;
      document.getElementById('lkcb-add').click();
      await sleep(500);
      const hidden = document.querySelectorAll(
        'tr.topic-list-item[data-lkcb-state="hidden"]',
      ).length;
      info('过滤联动：探测词 ' + probeWord + ' 的真实行隐藏数', hidden);
      assert('过滤联动：真实行命中隐藏', hidden > 0, 'hidden=' + hidden);
      document.getElementById('toggle-current-user').click();
      await sleep(300);
    }

    assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    failures.push('异常中断: ' + msg);
    results.push({
      name: '异常中断（后续断言未执行）',
      ok: false,
      detail: msg,
    });
    console.error('[lkcb-stress] 压测异常中断:', e);
  } finally {
    // —— 清理与输出：无论成败都恢复真实设置、关掉可能开着的菜单 ——
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    if (document.querySelector('.user-menu.menu-panel'))
      document.getElementById('toggle-current-user')?.click();

    console.log(
      '%c[lkcb-stress] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log(
        (r.ok ? '✅ ' : '❌ ') + (i + 1) + '. ' + r.name + ' —— ' + r.detail,
      ),
    );
    window.__lkcbStressResults = results;
    window.__lkcbStressRunning = false;
  }
})();
