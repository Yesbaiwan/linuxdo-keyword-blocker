/* eslint-disable */
// ============================================================================
// Linux.do Keyword Blocker — 海量关键词压测（浏览器控制台运行，linux.do 已登录页面）
// ============================================================================
//
// 【运行前提】
//   1. 页面已刷新（避免多实例），且已登录；
//   2. 先注入两个全局变量：
//        window.__LKCB_SOURCE__          = `<ld-blocker.user.js 完整内容>`
//        window.__LKCB_STRESS_KEYWORDS__ = [`关键词1`, `关键词2`, ...]（≥50 个）
//      关键词来自 tests/stress-keywords.txt（纯逗号分隔，可整行复制直接粘贴
//      进面板输入框导入），本地自动化流程读取后按逗号切分注入。
//
// 【流程】海量关键词依次压测两个表面：
//   A. 悬浮面板：油猴菜单命令触发 → 渲染耗时 → 结构检查（胶囊数/内部滚动/
//      footer 可见/无横向溢出/面板在视口内）→ 滚动到底删除胶囊 → × 关闭
//   B. 头像菜单视图：打开头像菜单 → 屏蔽词标签 → 同一套结构检查 →
//      滚动到底删除胶囊 → 关闭菜单（期望胶囊数比 A 少 1：A 阶段删掉了一个）
//   C. 过滤联动：通过 UI 添加一个当前页面真实标题前缀词，验证列表行隐藏数 > 0
//
// 【输出】每项 PASS/FAIL + 性能数字（渲染耗时 ms、隐藏行数等），挂到
//   window.__lkcbStressResults；结束后自动恢复原始设置并清理。
// ============================================================================

(async function () {
  if (window.__lkcbStressRunning) return console.warn('[lkcb-stress] 已在运行中');
  window.__lkcbStressRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  const keywords = window.__LKCB_STRESS_KEYWORDS__;
  if (!source || !Array.isArray(keywords) || keywords.length < 50) {
    console.error('[lkcb-stress] 缺少前置变量：__LKCB_SOURCE__（脚本源码）与 __LKCB_STRESS_KEYWORDS__（海量关键词数组，≥50 个）。');
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
    results.push({ name, ok, detail: ok ? (typeof detail !== 'string' ? JSON.stringify(detail) : detail) : String(detail || '') });
    if (ok) passed++;
    else failures.push(name);
  }
  // 只记录数字的「信息项」，不参与通过/失败
  function info(name, value) {
    results.push({ name, ok: true, detail: typeof value === 'number' ? String(value) : JSON.stringify(value) });
  }

  // 两表面的滚动区都是内部的 #lkcb-keywords，差别只在根节点与视口参照物
  function surfaceChecks(prefix) {
    const root =
      prefix === 'float'
        ? document.getElementById('lkcb-float')
        : document.querySelector('.panel-body-contents #lkcb-quick-access');
    if (!root) return { exists: false };
    const ul = root.querySelector('#lkcb-keywords');
    const footer = root.querySelector('.lkcb-footer');
    const fr = footer.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    return {
      exists: true,
      chips: ul.children.length,
      ulScrollable: ul.scrollHeight > ul.clientHeight,
      footerVisible: fr.bottom <= rr.bottom + 1 && fr.top >= rr.top - 1,
      noHorizOverflow: root.scrollWidth <= root.clientWidth,
      inViewport:
        (prefix === 'float'
          ? root
          : root.closest('.user-menu.menu-panel')
        ).getBoundingClientRect().bottom <= innerHeight,
    };
  }
  // expectedChips：当前应渲染的胶囊数（菜单阶段比悬浮阶段少 1 个，故显式传入）
  const surfaceOk = (c, expectedChips) =>
    c.exists &&
    c.chips === expectedChips &&
    c.ulScrollable &&
    c.footerVisible &&
    c.noHorizOverflow &&
    c.inViewport;

  try {
    // —— 准备：写入海量关键词 + 注入脚本 ——
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ enabled: true, hideMode: 'hide', keywords }),
    );
    window.__menuCommands = [];
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
      registerMenuCommand: (label, cb) => window.__menuCommands.push(cb),
    };
    (0, eval)(source);
    await sleep(500);

    // —— A. 悬浮面板压测 ——
    const t0 = performance.now();
    window.__menuCommands[0]();
    const float = document.getElementById('lkcb-float');
    // 等待渲染完成（同步渲染，此处仅留出布局时间）
    await sleep(300);
    const renderMs = Math.round(performance.now() - t0);
    const fa = surfaceChecks('float');
    fa.renderMs = renderMs;
    assert(
      '悬浮面板：海量关键词渲染完整且无变形',
      surfaceOk(fa, keywords.length),
      JSON.stringify(fa),
    );
    info('悬浮面板渲染耗时 ms', renderMs);

    // 滚动到底删除最后一个胶囊仍工作
    await new Promise((resolve) => {
      const ul = float.querySelector('#lkcb-keywords');
      ul.scrollTop = ul.scrollHeight;
      const before = ul.children.length;
      ul.lastElementChild.querySelector('button').click();
      setTimeout(() => {
        assert(
          '悬浮面板：滚动到底删除胶囊正常',
          float.querySelectorAll('#lkcb-keywords li').length === before - 1,
        );
        resolve();
      }, 300);
    });
    document.getElementById('lkcb-float-close').click();
    await sleep(200);
    assert('悬浮面板：× 关闭正常', !document.getElementById('lkcb-float'));

    // —— B. 头像菜单视图压测 ——
    document.getElementById('toggle-current-user').click();
    await sleep(800);
    const entry = document.getElementById('lkcb-menu-entry');
    assert('头像菜单：入口正常注入', !!entry);
    entry.click();
    await sleep(400);
    const ma = surfaceChecks('menu');
    assert(
      '菜单视图：海量关键词渲染完整且无变形',
      surfaceOk(ma, keywords.length - 1),
      JSON.stringify(ma),
    );

    // 滚动到底删除最后一个胶囊仍工作
    await new Promise((resolve) => {
      const ul = document.querySelector('.panel-body-contents #lkcb-keywords');
      ul.scrollTop = ul.scrollHeight;
      const before = ul.children.length;
      ul.lastElementChild.querySelector('button').click();
      setTimeout(() => {
        assert(
          '菜单视图：滚动到底删除胶囊正常',
          document.querySelectorAll('.panel-body-contents #lkcb-keywords li').length ===
            before - 1,
        );
        resolve();
      }, 300);
    });
    document.getElementById('toggle-current-user').click();
    await sleep(400);

    // —— C. 过滤联动：用当前页面真实标题前缀作为关键词 ——
    // 全程走运行中实例的 UI（重开菜单 → 清空 → 添加探测词），不重新 eval
    // （页内二次 eval 会被站点 CSP 间歇性拦截）
    const sampleTitle = (
      document.querySelector('tr.topic-list-item a.title, tr.topic-list-item a[href^="/t/"]')
        ?.textContent || ''
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
      const input = document.getElementById('lkcb-input');
      input.value = probeWord;
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
    results.push({ name: '异常中断（后续断言未执行）', ok: false, detail: msg });
    console.error('[lkcb-stress] 压测异常中断:', e);
  } finally {
    // —— 清理与输出：无论成败都恢复真实设置、移除测试面板、关掉可能开着的菜单 ——
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    document.getElementById('lkcb-float')?.remove();
    if (document.querySelector('.user-menu.menu-panel'))
      document.getElementById('toggle-current-user')?.click();

    console.log(
      '%c[lkcb-stress] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log((r.ok ? '✅ ' : '❌ ') + (i + 1) + '. ' + r.name + ' —— ' + r.detail),
    );
    window.__lkcbStressResults = results;
    window.__lkcbStressRunning = false;
  }
})();
