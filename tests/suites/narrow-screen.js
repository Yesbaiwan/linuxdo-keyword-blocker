/* eslint-disable */
// 窄屏深测：滑入抽屉视图/内部滚动/footer 可见/无横向溢出/过滤，自带 43 个长短中英混合词。
// 必须桌面 UA + 移动 UA 各跑一遍（站点移动样式差异只有移动 UA 能复现），测完清除视口模拟。
// 结果挂 window.__lkcbNarrowResults。

(async function () {
  if (window.__lkcbNarrowRunning)
    return console.warn('[lkcb-narrow] 已在运行中');
  window.__lkcbNarrowRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error(
      '[lkcb-narrow] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。',
    );
    window.__lkcbNarrowRunning = false;
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
      detail: ok ? String(detail || '') : String(detail || ''),
    });
    if (ok) passed++;
    else failures.push(name);
  }
  function info(name, value) {
    results.push({ name, ok: true, detail: String(value) });
  }

  // 长短中英混合词集：前 6 个为用户真实词，末尾两个超长词压换行/截断。
  // 全部转成仅标题规则注入（行文本会带「标题:」前缀）
  const wrapKeywords = [
    '百度网盘',
    '夸克',
    '女装',
    'giffgaff',
    '富可敌国',
    '红包',
    '羊毛',
    '优惠券',
    '代充',
    '代练',
    '网赚',
    '引流',
    '加微信',
    '招聘',
    '内推',
    '实习',
    '外包',
    'ChatGPT',
    'Claude',
    'Gemini',
    '大模型',
    'DeepSeek',
    'Python',
    'JavaScript',
    'TypeScript',
    'Rust',
    'Golang',
    'Docker',
    'Kubernetes',
    'NAS',
    '树莓派',
    'VPS',
    '建站',
    '机场',
    '节点',
    '教育优惠',
    '学生优惠',
    'Office365',
    'Cloudflare',
    'GitHub',
    '本文内容由AI生成仅供参考请谨慎甄别',
    '这是一个非常非常长的中文关键词用来测试窄屏下规则行的换行与截断表现',
  ];
  wrapKeywords.push('scientific-computing-with-python-超长中英混合关键词');

  try {
    // —— 同步准备段：采样探测词 + 写设置 + 注入（必须保持在首个 await 之前，
    //    定时器回调里的 eval 会被站点 CSP 拦截） ——
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    const sampleTitle = (
      document.querySelector(
        'tr.topic-list-item a.title, tr.topic-list-item a[href^="/t/"]',
      )?.textContent || ''
    ).trim();
    const probeWord = sampleTitle.slice(0, 8);
    // 探测词保证过滤断言有确定性命中；探不到标题也能跑其余断言
    const storedRules = (
      probeWord.length >= 4 ? [probeWord, ...wrapKeywords] : [...wrapKeywords]
    ).map((k) => ({ category: null, tag: '', title: k }));
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ enabled: true, hideMode: 'hide', rules: storedRules }),
    );
    (0, eval)(source);
    await sleep(600);
    const viewport = { w: innerWidth, h: innerHeight };
    info('视口', viewport.w + '×' + viewport.h);

    // ◆ A. 头像菜单视图（窄屏为滑入抽屉）
    // 已知怪癖：视口变更后首次程序化点击可能不生效（Ember 重渲染头部），重试一次
    let entry = null;
    for (let i = 0; i < 2 && !entry; i++) {
      document.getElementById('toggle-current-user')?.click();
      await sleep(900);
      entry = document.getElementById('lkcb-menu-entry');
      if (!entry) {
        document.getElementById('toggle-current-user')?.click();
        await sleep(500);
      }
    }
    assert('头像菜单：入口正常注入', !!entry);
    if (entry) {
      entry.click();
      await sleep(400);
      const view = document.querySelector(
        '.panel-body-contents #lkcb-quick-access',
      );
      assert('头像菜单：规则视图打开', !!view);
      if (view) {
        const ul = view.querySelector('#lkcb-rules');
        const chips = [...ul.querySelectorAll('li')];
        const footer = view.querySelector('.lkcb-footer');
        const vr = view.getBoundingClientRect();
        const fr = footer.getBoundingClientRect();
        assert(
          '菜单视图：规则行数量完整',
          ul.children.length === storedRules.length,
          `实际 ${ul.children.length} / 期望 ${storedRules.length}`,
        );
        assert(
          '菜单视图：规则行完整可达（可滚动或全部容纳）、footer 可见、无横向溢出',
          (ul.scrollHeight > ul.clientHeight ||
            chips[chips.length - 1].getBoundingClientRect().bottom <=
              ul.getBoundingClientRect().bottom + 1) &&
            fr.bottom <= vr.bottom + 1 &&
            fr.top >= vr.top - 1 &&
            view.scrollWidth <= view.clientWidth + 1,
          `ul ${ul.scrollHeight}/${ul.clientHeight} footer ${Math.round(fr.top)}~${Math.round(fr.bottom)} view ${Math.round(vr.top)}~${Math.round(vr.bottom)}`,
        );
        assert(
          '菜单视图：完整落在抽屉可视区内',
          vr.top >= -1 && vr.bottom <= viewport.h + 1,
          `view ${Math.round(vr.top)}~${Math.round(vr.bottom)} viewportH=${viewport.h}`,
        );
      }
      document.getElementById('toggle-current-user')?.click();
      await sleep(400);
    }

    // ◆ B. 页面级
    const hidden = document.querySelectorAll(
      'tr.topic-list-item[data-lkcb-state="hidden"]',
    ).length;
    info('命中隐藏行数（含探测词与关键词命中）', hidden);
    assert('过滤：窄屏下真实行命中隐藏', hidden > 0, 'hidden=' + hidden);
    assert(
      '页面：无横向溢出（脚本 UI 不撑破视口）',
      document.documentElement.scrollWidth <= viewport.w + 1,
      `doc ${document.documentElement.scrollWidth} vs viewport ${viewport.w}`,
    );

    assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    failures.push('异常中断: ' + msg);
    results.push({
      name: '异常中断（后续断言未执行）',
      ok: false,
      detail: msg,
    });
    console.error('[lkcb-narrow] 窄屏测试异常中断:', e);
  } finally {
    // —— 清理与输出：恢复设置、关掉可能开着的抽屉 ——
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    if (document.querySelector('.user-menu.menu-panel'))
      document.getElementById('toggle-current-user')?.click();

    console.log(
      '%c[lkcb-narrow] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log(
        (r.ok ? '✅ ' : '❌ ') +
          (i + 1) +
          '. ' +
          r.name +
          (r.detail ? ' —— ' + r.detail : ''),
      ),
    );
    window.__lkcbNarrowResults = results;
    window.__lkcbNarrowRunning = false;
  }
})();
