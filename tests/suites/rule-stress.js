/* eslint-disable */
// ============================================================================
// Linux.do Keyword Blocker — 规则语义压测（Chrome DevTools MCP 驱动，见 tests/README.md）
// ============================================================================
// 【目的】验证「类别/标签/标题」规则的真实匹配语义。与 bulk-stress 的分工：
//   bulk-stress 把海量关键词转成仅标题规则压 UI 承载；本套件用少量真实组合
//   规则压匹配语义。规则集预写在 tests/fixtures/rule-stress.json（17 条，
//   格式与脚本导出一致），分类 ID 取自 2026-09 实测：
//   4=开发调优 11=搞七捻三 14=资源荟萃 35=搞七捻三 Lv1（子分类）。
//   1-3  仅标题高频词；4  大写形态（大小写不敏感）；5  特殊字符词；
//   6-7  标签（英文小写形态/中文）；8-10  仅类别（父分类精确匹配，不连带
//   子分类；35 验证子分类单独命中）；11-15  类别/标签/标题 AND 组合（含
//   三字段全填）；16  永不命中词（误伤检测）；17  enabled:false 停用规则
//   （必命中场景但不得生效）。
//
// 【核心方法】影子匹配器：测试内部独立实现一遍规则匹配（读行的徽章 ID /
//   标签 / 标题文本），对每个帖子行算出「期望状态」，与脚本实际写入的
//   data-lkcb-state / data-lkcb-match 逐行对比。信息流内容怎么变断言都成立，
//   不依赖任何一条规则当轮必须命中；各规则的真实命中行数以 info 输出供参考。
//
// 【流程】A. 预置存储 + 注入 → 影子对比第一轮；B. 规则级断言（永不命中词
//   0 行 / 停用规则 0 行 / 期望命中总数 > 0）；C. UI 联动（菜单行数、停用行
//   删除线、勾选启用停用规则后影子对比第二轮）；D. 全程零 JS 错误。
// 【输出】window.__lkcbRuleStressResults；结束自动恢复原始设置并清理。
// ============================================================================

(async function () {
  if (window.__lkcbRuleStressRunning)
    return console.warn('[lkcb-rule-stress] 已在运行中');
  window.__lkcbRuleStressRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const source = window.__LKCB_SOURCE__;
  const rulesJson = window.__LKCB_RULE_STRESS__; // fixtures/rule-stress.json 原文
  let rules = null;
  try {
    rules = JSON.parse(rulesJson);
  } catch (e) {
    /* 走下方校验报错 */
  }
  if (
    !source ||
    !Array.isArray(rules) ||
    rules.length < 10 ||
    rules.some((r) => r == null || (r.category == null && !r.tag && !r.title))
  ) {
    console.error(
      '[lkcb-rule-stress] 缺少前置变量：__LKCB_SOURCE__（脚本源码）与 __LKCB_RULE_STRESS__（规则 JSON，≥10 条）。',
    );
    window.__lkcbRuleStressRunning = false;
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
      detail: ok ? String(detail ?? '') : String(detail || '断言失败'),
    });
    if (ok) passed++;
    else failures.push(name);
  }
  function info(name, value) {
    results.push({
      name,
      ok: true,
      detail: typeof value === 'number' ? String(value) : JSON.stringify(value),
    });
  }

  // —— 影子匹配器：与主脚本 findMatchedRule/applyTopicState 同语义的独立实现 ——
  const TOPIC_SELECTORS = [
    '.fps-result',
    '.latest-topic-list-item',
    '.topic-list-item',
    '.topic-post',
    '[data-topic-id]',
  ].join(',');
  const TITLE_SELECTORS = ['.title', '.topic-title', "a[href^='/t/']"];
  const norm = (v) => String(v || '').toLocaleLowerCase();

  // 顶层行：嵌套命中的内层元素与主脚本一样不参与
  function topicRows() {
    return [...document.querySelectorAll(TOPIC_SELECTORS)].filter(
      (el) => !el.parentElement.closest(TOPIC_SELECTORS),
    );
  }

  function rowTitle(row) {
    for (const sel of TITLE_SELECTORS) {
      const t = row.querySelector(sel)?.textContent.trim();
      if (t) return t;
    }
    return '';
  }

  function matchesRule(row, rule) {
    if (rule.enabled === false) return false; // 停用规则主脚本不应用
    const catIds = new Set();
    row
      .querySelectorAll('span.badge-category[data-category-id]')
      .forEach((el) => {
        const id = el.getAttribute('data-category-id');
        if (id) catIds.add(id);
      });
    const tags = [...row.querySelectorAll('a.discourse-tag')]
      .map((el) => norm(el.textContent.trim()))
      .filter(Boolean);
    const title = norm(rowTitle(row));
    if (rule.category != null && !catIds.has(String(rule.category))) return false;
    if (rule.tag && !tags.some((t) => t.includes(norm(rule.tag)))) return false;
    if (rule.title && !title.includes(norm(rule.title))) return false;
    return true;
  }

  // 逐行对比期望状态与实际 data 属性（预置 hideMode: 'hide'，命中即 hidden）
  function shadowCompare(ruleList) {
    const rows = topicRows();
    let mismatch = 0;
    let expectHit = 0;
    const samples = [];
    for (const row of rows) {
      const hit = ruleList.find((r) => matchesRule(row, r));
      const wantState = hit ? 'hidden' : null;
      const gotState = row.dataset.lkcbState || null;
      const gotMatch = row.hasAttribute('data-lkcb-match');
      if (wantState === gotState && !!hit === gotMatch) {
        if (hit) expectHit++;
        continue;
      }
      mismatch++;
      if (samples.length < 5)
        samples.push(
          rowTitle(row).slice(0, 40) +
            ` 期望=${wantState || '无'}/match=${!!hit} 实际=${gotState || '无'}/match=${gotMatch}`,
        );
    }
    return { rows: rows.length, mismatch, expectHit, samples };
  }

  function ruleHitCount(rule) {
    let n = 0;
    for (const row of topicRows()) if (matchesRule(row, rule)) n++;
    return n;
  }

  try {
    // —— A. 预置 + 注入 + 影子对比第一轮 ——
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ enabled: true, hideMode: 'hide', rules }),
    );
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    (0, eval)(source);
    await sleep(800);
    assert('注入启动：脚本样式已注入', !!document.getElementById('lkcb-style'));
    const first = shadowCompare(rules);
    info('页面顶层帖子行数', first.rows);
    assert('列表页存在帖子行', first.rows > 0);
    assert(
      '影子对比：全部行期望状态与实际一致',
      first.mismatch === 0,
      first.mismatch + ' 行不一致; ' + first.samples.join(' | '),
    );
    info('期望命中行数（规则集）', first.expectHit);

    // —— B. 规则级断言 ——
    const neverRule = rules[rules.length - 2]; // 永不命中词（倒数第 2 条）
    const offRule = rules[rules.length - 1]; // enabled:false（最后 1 条）
    assert(
      '永不命中词规则 0 行命中',
      ruleHitCount(neverRule) === 0,
      ruleHitCount(neverRule),
    );
    assert(
      '停用规则不生效（0 行命中）',
      ruleHitCount(offRule) === 0 && offRule.enabled === false,
    );
    assert('规则集整体有命中（信息流正常）', first.expectHit > 0);
    info(
      '各规则命中行数',
      rules.map((r, i) => {
        const parts = [];
        if (r.category != null) parts.push('cat=' + r.category);
        if (r.tag) parts.push('tag=' + r.tag);
        if (r.title) parts.push('title=' + r.title);
        if (r.enabled === false) parts.push('停用');
        return '#' + (i + 1) + ' ' + parts.join('+') + ' → ' + ruleHitCount(r);
      }),
    );

    // —— C. UI 联动 ——
    document.getElementById('toggle-current-user').click();
    await sleep(800);
    const entry = document.getElementById('lkcb-menu-entry');
    assert('头像菜单：入口正常注入', !!entry);
    entry.click();
    await sleep(400);
    const lis = document.querySelectorAll(
      '.panel-body-contents #lkcb-rules li',
    );
    assert(
      '菜单视图：规则行数与规则数一致',
      lis.length === rules.length,
      `${lis.length} vs ${rules.length}`,
    );
    assert(
      '菜单视图：停用规则行画删除线（lkcb-off）',
      document.querySelectorAll('.panel-body-contents #lkcb-rules li.lkcb-off')
        .length === 1,
    );
    // 勾选启用最后一条停用规则 → 运行中实例实时生效 → 影子对比第二轮
    const offLi = lis[lis.length - 1];
    const check = offLi && offLi.querySelector('input[type=checkbox]');
    assert('菜单视图：停用规则行存在勾选框', !!check && !check.checked);
    if (check) {
      check.click();
      await sleep(500);
      const rulesAfter = rules.map((r, i) =>
        i === rules.length - 1 ? { ...r, enabled: true } : r,
      );
      const second = shadowCompare(rulesAfter);
      info('启用停用规则后的命中行数', ruleHitCount(rulesAfter[rulesAfter.length - 1]));
      assert(
        '勾选启用后影子对比仍逐行一致',
        second.mismatch === 0,
        second.mismatch + ' 行不一致; ' + second.samples.join(' | '),
      );
    }
    document.getElementById('toggle-current-user').click();
    await sleep(300);

    assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    failures.push('异常中断: ' + msg);
    results.push({
      name: '异常中断（后续断言未执行）',
      ok: false,
      detail: msg,
    });
    console.error('[lkcb-rule-stress] 压测异常中断:', e);
  } finally {
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);
    if (document.querySelector('.user-menu.menu-panel'))
      document.getElementById('toggle-current-user')?.click();

    console.log(
      '%c[lkcb-rule-stress] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log(
        (r.ok ? '✅ ' : '❌ ') + (i + 1) + '. ' + r.name + ' —— ' + r.detail,
      ),
    );
    window.__lkcbRuleStressResults = results;
    window.__lkcbRuleStressRunning = false;
  }
})();
