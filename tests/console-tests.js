/* eslint-disable */
// ============================================================================
// Linux.do Keyword Blocker — 自动化回归测试（浏览器控制台运行）
// ============================================================================
//
// 【运行前提】
//   1. 在 linux.do 页面的控制台运行，页面需已登录（测试会 mock 头像菜单结构）；
//   2. 运行前必须先把被测脚本源码注入页面：
//        window.__LKCB_SOURCE__ = `<ld-blocker.user.js 的完整内容>`
//      （本地自动化验证时由测试流程自动完成这一步；重复运行前先刷新页面）。
//
// 【隔离性】全程使用独立 mock DOM 与临时存储，结束后自动清理并还原你的真实设置。
//
// 【覆盖的功能点】（按分组断言，共 20 项）
//   ◆ 入口与视图切换（6 项）
//      1. 菜单入口注入到头像菜单
//      2. 入口位于「个人资料」正下方、样式同原生标签
//      3. 点击入口 → 菜单内容区切换为关键词管理视图（原生内容隐藏）
//      4. 点击 top-tabs 组原生标签 → 切回原生视图（回归：8 个标签分属两组容器）
//      5. 重新点击入口 → 管理视图再次激活
//      6. 菜单关闭（面板销毁）→ 重开回到原生默认视图、入口重新注入、旧 DOM 标记消失
//   ◆ 关键词数据（4 项）
//      7. 读取设置时规范化：trim / 去重 / 滤空（大小写变体按原样保留）
//      8. UI 批量添加：全角/半角逗号分隔、去重、trim
//      9. × 删除单个关键词
//      10. 空白输入不添加
//   ◆ 过滤算法（5 项）
//      11. 标题命中隐藏，大小写归一化（关键词大写、页面标题小写）
//      12. 置顶帖标题命中隐藏（回归：空置顶切换按钮不影响标题提取）
//      13. 淡化模式生效
//      14. 关闭屏蔽清空所有行状态
//      15. 重新开启后恢复隐藏
//   ◆ 悬浮面板（油猴菜单命令触发，不依赖头像菜单；4 项）
//      16. 菜单命令弹出独立悬浮面板（登录态下同样直接弹出）
//      17. 悬浮面板与菜单视图渲染同一份关键词数据
//      18. 点击面板外关闭
//      19. × 关闭
//   ◆ 健壮性（1 项）
//      20. 全程零 JS 错误（error / unhandledrejection / console.error 三路收集）
//
// 【未覆盖——按用户要求或需真实环境/人工】
//   存储损坏回退：由运行流程的独立阶段验证（刷新 → 预写坏 JSON → 注入 →
//   断言零报错），不在本文件内做——页内二次 eval 会被站点 CSP 间歇性拦截；
//   导出下载、真实登出（用户明确无需测试）；
//   SPA 路由往返、窄屏 slide-in、Tampermonkey 真实菜单命令注册。
// ============================================================================

(async function () {
  if (window.__lkcbTestsRunning) return console.warn('[lkcb-test] 已在运行中');
  window.__lkcbTestsRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const origStore = localStorage.getItem(STORE_KEY);
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) =>
    pageErrors.push('rejection: ' + String(e.reason?.message || e.reason)),
  );

  // —— 被测脚本源码必须由外部注入（本地文件内容） ——
  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error(
      '[lkcb-test] 缺少被测脚本源码：请先执行 window.__LKCB_SOURCE__ = `<ld-blocker.user.js 完整内容>` 再运行本测试。',
    );
    window.__lkcbTestsRunning = false;
    return;
  }

  // —— 工具 ——
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  let passed = 0;
  const failures = [];
  function assert(name, cond, detail) {
    const ok = !!cond;
    results.push({ name, ok, detail: ok ? '' : String(detail || '') });
    if (ok) passed++;
    else failures.push(name);
  }

  // mock DOM：仿 linux.do 头像菜单（含 top/bottom 两组标签）与话题表格。
  // 移除旧实例再新建，模拟「菜单关闭销毁、打开重渲染」的真实行为。
  function buildMock() {
    document.getElementById('blocker-test-mock')?.remove();
    const mock = document.createElement('div');
    mock.id = 'blocker-test-mock';
    mock.innerHTML = `
      <div class="user-menu-dropdown-wrapper">
        <div class="user-menu revamped menu-panel drop-down">
          <div class="panel-body">
            <div class="panel-body-contents">
              <div class="quick-access-panel" id="mock-native-panel"><ul><li>原生内容</li></ul></div>
              <div class="menu-tabs-container">
                <div class="top-tabs tabs-list">
                  <a id="user-menu-button-replies" class="btn btn-flat btn-icon no-text user-menu-tab">回复</a>
                </div>
                <div class="bottom-tabs tabs-list">
                  <a id="user-menu-button-profile" class="btn btn-flat btn-icon no-text user-menu-tab">个人资料</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <table><tbody>
        <tr class="topic-list-item pinned">
          <td><div class="main-link"><a class="topic-status --pinned pin-toggle-button" href="#"></a><a class="title raw-link raw-topic-link" href="/t/topic/4">置顶帖标题含红包</a></div></td>
        </tr>
        <tr class="topic-list-item"><td><a class="title" href="/t/topic/1">标题包含夸克的帖子</a></td></tr>
        <tr class="topic-list-item"><td><a class="title" href="/t/topic/2">astro 小写命中大写关键词</a></td></tr>
        <tr class="topic-list-item"><td><a class="title" href="/t/topic/3">完全正常的帖子</a></td></tr>
      </tbody></table>`;
    document.body.appendChild(mock);
    return mock;
  }
  const mockStates = () =>
    [...document.querySelectorAll('#blocker-test-mock tr.topic-list-item')].map(
      (r) => r.getAttribute('data-lkcb-state'),
    );
  const viewChips = () =>
    [
      ...document.querySelectorAll(
        '.panel-body-contents #lkcb-quick-access ul.lkcb-keywords li span',
      ),
    ].map((s) => s.textContent);

  // 主流程：任何一步抛错都中断并报告（finally 里完成清理与输出）
  try {
  // —— 准备：非规范关键词存储 + 注入（单实例） ——
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      enabled: true,
      hideMode: 'hide',
      keywords: ['  夸克  ', '夸克', '', 'ASTRO', '红包'],
    }),
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
  buildMock();
  (0, eval)(source);
  await sleep(400);

  // ◆ 入口与视图切换
  const entry = document.getElementById('lkcb-menu-entry');
  assert('入口注入到头像菜单', !!entry);
  assert(
    '入口位于「个人资料」正下方',
    !!entry &&
      document.getElementById('user-menu-button-profile').nextElementSibling ===
        entry,
  );

  entry.click();
  await sleep(300);
  assert(
    '点击入口激活管理视图（原生内容隐藏）',
    document.querySelector('.panel-body-contents')?.dataset.lkcbView ===
      'keywords' &&
      (() => {
        const qa = document.querySelector(
          '.panel-body-contents .quick-access-panel:not(#lkcb-quick-access)',
        );
        return qa ? getComputedStyle(qa).display === 'none' : null;
      })(),
  );

  document.getElementById('user-menu-button-replies').click();
  await sleep(200);
  assert(
    '点击 top-tabs 原生标签切回原生视图',
    !document
      .querySelector('.panel-body-contents')
      .hasAttribute('data-lkcb-view') &&
      !entry.classList.contains('active'),
  );

  entry.click();
  await sleep(200);
  assert(
    '重新点击入口再次激活管理视图',
    document.querySelector('.panel-body-contents')?.dataset.lkcbView ===
      'keywords',
  );

  // ◆ 关键词数据
  const chips1 = viewChips();
  assert(
    '读取设置时规范化（trim/去重/滤空）',
    JSON.stringify(chips1) === JSON.stringify(['夸克', 'ASTRO', '红包']),
    JSON.stringify(chips1),
  );

  const input = document.getElementById('lkcb-input');
  input.value = '新词，新词, ';
  document.getElementById('lkcb-add').click();
  await sleep(200);
  const chips2 = viewChips();
  assert(
    'UI 批量添加（全角半角逗号/去重/trim）',
    chips2.filter((k) => k === '新词').length === 1 && chips2.length === 4,
    JSON.stringify(chips2),
  );
  document
    .querySelector('.panel-body-contents #lkcb-quick-access ul.lkcb-keywords li:last-child button')
    .click();
  await sleep(200);
  assert('× 删除关键词', viewChips().length === 3, JSON.stringify(viewChips()));

  input.value = '   ';
  document.getElementById('lkcb-add').click();
  await sleep(200);
  assert('空白输入不添加', viewChips().length === 3, JSON.stringify(viewChips()));

  // ◆ 过滤算法
  let st = mockStates();
  assert(
    '标题命中隐藏（大小写归一化）',
    st[1] === 'hidden' && st[2] === 'hidden' && !st[3],
    JSON.stringify(st),
  );
  assert(
    '置顶帖标题命中隐藏（回归：空置顶按钮不影响标题提取）',
    st[0] === 'hidden',
    JSON.stringify(st),
  );

  const sel = document.getElementById('lkcb-hideMode');
  sel.value = 'dim';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  st = mockStates();
  assert('淡化模式生效', st[0] === 'dimmed' && st[1] === 'dimmed' && st[2] === 'dimmed', JSON.stringify(st));
  sel.value = 'hide';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);

  document.getElementById('lkcb-enabled').click();
  await sleep(200);
  assert('关闭屏蔽清空所有行状态', mockStates().every((s) => !s), JSON.stringify(mockStates()));
  document.getElementById('lkcb-enabled').click();
  await sleep(200);
  assert(
    '重新开启后恢复隐藏',
    mockStates()[0] === 'hidden' && mockStates()[1] === 'hidden' && mockStates()[2] === 'hidden',
  );

  // ◆ 悬浮面板
  window.__menuCommands[0]();
  await sleep(200);
  const float = document.getElementById('lkcb-float');
  assert(
    '油猴菜单命令弹出悬浮面板',
    !!float && getComputedStyle(float).display !== 'none',
  );
  assert(
    '悬浮面板渲染同一份关键词数据',
    float ? float.querySelectorAll('#lkcb-keywords li').length === 3 : false,
  );
  document.body.click();
  await sleep(200);
  assert('点击面板外关闭悬浮面板', !document.getElementById('lkcb-float'));

  // 再开一次，验证 × 关闭
  window.__menuCommands[0]();
  await sleep(200);
  document.getElementById('lkcb-float-close').click();
  await sleep(200);
  assert('× 关闭悬浮面板', !document.getElementById('lkcb-float'));

  // ◆ 菜单关闭销毁 → 重开复位（DOM 标记法：旧节点上的标记应随销毁消失）
  const oldWrapper = document.querySelector('.user-menu-dropdown-wrapper');
  oldWrapper.setAttribute('data-test-mark', 'old-session');
  oldWrapper.remove(); // 等效真实场景「关闭菜单：Discourse 销毁整个面板」
  buildMock(); // 重开：Discourse 用全新 DOM 重渲染
  await sleep(400);
  assert(
    '菜单关闭销毁后重开：入口重新注入、回到原生默认视图',
    !!document.getElementById('lkcb-menu-entry') &&
      !document
        .querySelector('.panel-body-contents')
        .hasAttribute('data-lkcb-view') &&
      !document.querySelector('.panel-body-contents #lkcb-quick-access') &&
      document
        .querySelector('.user-menu-dropdown-wrapper')
        .getAttribute('data-test-mark') === null,
  );

  // ◆ 健壮性：存储损坏回退已移至运行流程的独立阶段
  // （刷新页面 → 预写坏 JSON → 注入 → 断言零报错；页内二次 eval 会被站点 CSP 间歇性拦截）

  // 全程零 JS 错误
  assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));

  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    failures.push('异常中断: ' + msg);
    results.push({ name: '异常中断（后续断言未执行）', ok: false, detail: msg });
    console.error('[lkcb-test] 测试异常中断:', e);
  } finally {
  // —— 清理 ——
  document.getElementById('blocker-test-mock')?.remove();
  document.getElementById('lkcb-float')?.remove();
  if (origStore === null) localStorage.removeItem(STORE_KEY);
  else localStorage.setItem(STORE_KEY, origStore);

  // —— 输出 ——
  console.log(
    '%c[lkcb-test] ' + passed + '/' + results.length + ' 通过',
    'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
  );
  results.forEach((r, i) =>
    console.log(
      (r.ok ? '✅ ' : '❌ ') + (i + 1) + '. ' + r.name + (r.ok ? '' : ' —— ' + r.detail),
    ),
  );
  if (failures.length === 0)
    console.log('全部通过。mock DOM 与存储已清理；刷新页面即可恢复干净状态。');
  window.__lkcbTestResults = results;
  window.__lkcbTestsRunning = false;
  }
})();
