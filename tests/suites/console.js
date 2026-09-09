/* eslint-disable */
// 功能回归测试：34 项断言（登录门槛/规则 CRUD/picker/精确匹配/AND 语义/单规则启停/行内编辑/存储损坏回退）。
// 自建 mock DOM（必须含 #current-user）隔离运行，结束自动清理并还原设置。
// 结果挂 window.__lkcbTestResults（__lkcbTestsRunning 为结束标志）。

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

  // mock DOM：仿 linux.do 头像菜单（含 top/bottom 两组标签）、话题表格与头部。
  // 行内带类别徽章（data-category-id）与标签（discourse-tag）。
  // 移除旧实例再新建，模拟「菜单关闭销毁、打开重渲染」的真实行为。
  // loggedIn=false 时不渲染 #current-user，模拟未登录（脚本应等待登录）
  function buildMock(loggedIn = true) {
    document.getElementById('blocker-test-mock')?.remove();
    const mock = document.createElement('div');
    mock.id = 'blocker-test-mock';
    mock.innerHTML = `
      <div class="d-header"><ul class="header-buttons">${loggedIn ? '<li id="current-user" class="header-dropdown-toggle"></li>' : ''}</ul></div>
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
          <td><a class="discourse-tag" href="/tag/纯水">纯水</a></td>
          <td><span class="badge-category" data-category-id="11"><span class="badge-category__name">搞七捻三</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/1">标题包含夸克的帖子</a></td>
          <td><a class="discourse-tag" href="/tag/人工智能">人工智能</a></td>
          <td><span class="badge-category" data-category-id="4"><span class="badge-category__name">开发调优</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/2">astro 小写命中大写关键词</a></td>
          <td><a class="discourse-tag" href="/tag/纯水">纯水</a></td>
          <td><span class="badge-category" data-category-id="4"><span class="badge-category__name">开发调优</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/3">完全正常的帖子</a></td>
          <td><span class="badge-category" data-category-id="11"><span class="badge-category__name">搞七捻三</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/5">another 完全正常帖</a></td>
          <td><a class="discourse-tag" href="/tag/人工智能">人工智能</a></td>
          <td><span class="badge-category" data-category-id="4"><span class="badge-category__name">开发调优</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/6">子分类专属帖</a></td>
          <td><span class="badge-category" data-category-id="20"><span class="badge-category__name">开发调优 Lv1</span></span></td>
        </tr>
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
        '.panel-body-contents #lkcb-quick-access ul.lkcb-rules li span',
      ),
    ].map((s) => s.textContent);

  // UI 助手：操作添加表单的类别 picker、填标签标题并点击添加
  // categoryId 为空 = 选「不按类别筛选」（点清除按钮）
  async function addRuleViaUI(categoryId, tag, title) {
    const view = document.querySelector(
      '.panel-body-contents #lkcb-quick-access',
    );
    const picker = view.querySelector('#lkcb-form-cat .lkcb-cat-picker');
    const input = picker.querySelector('.lkcb-cat-input');
    if (categoryId) {
      input.focus(); // 打开全量下拉
      await sleep(50);
      picker.querySelector(`.lkcb-cat-item[data-id="${categoryId}"]`).click();
      await sleep(50);
    } else {
      picker.querySelector('.lkcb-cat-clear').click();
    }
    view.querySelector('#lkcb-rule-tag').value = tag || '';
    view.querySelector('#lkcb-rule-title').value = title || '';
    view.querySelector('#lkcb-add').click();
    await sleep(200);
  }

  // 添加表单的类别 picker（树就绪探测与 picker 断言共用）
  const formPicker = () =>
    document.querySelector(
      '.panel-body-contents #lkcb-form-cat .lkcb-cat-picker',
    );

  // 主流程：任何一步抛错都中断并报告（finally 里完成清理与输出）
  try {
    // —— 准备：旧版关键词格式存储（验证迁移）+ 注入（单实例） ——
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        enabled: true,
        hideMode: 'hide',
        keywords: ['  夸克  ', '夸克', '', 'ASTRO', '红包'],
      }),
    );
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    // 真实页面可能已登录，而脚本 isLoggedIn 看的是整个 document 的 #current-user。
    // 已登录时临时改掉真实头部的 id 模拟未登录；断言后恢复 id 即等效 SPA 登录
    //（登录观察器只看 childList，恢复后追加一个注释节点触发它重新检查）
    const realUserItem = document.getElementById('current-user');
    if (realUserItem) realUserItem.id = 'current-user-lkcb-suspended';
    buildMock(false); // 未登录：脚本必须等到登录才启动
    (0, eval)(source);
    await sleep(400);

    // ◆ 登录门槛与入口
    assert(
      '未登录不启动：无入口、不过滤',
      !document.getElementById('lkcb-menu-entry') &&
        mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );
    // 模拟 SPA 登录：已登录环境恢复真实头部 id；登出环境往 mock 插入 #current-user
    if (realUserItem) {
      realUserItem.id = 'current-user';
      document.body.appendChild(document.createComment('lkcb-login-probe'));
    } else {
      document
        .querySelector('#blocker-test-mock .header-buttons')
        .insertAdjacentHTML('beforeend', '<li id="current-user"></li>');
    }
    await sleep(600);
    const entry = document.getElementById('lkcb-menu-entry');
    assert(
      '登录后自动启动：入口注入 + 迁移规则立即生效',
      !!entry &&
        mockStates()[0] === 'hidden' &&
        mockStates()[1] === 'hidden' &&
        mockStates()[2] === 'hidden',
      JSON.stringify(mockStates()),
    );
    assert(
      '入口位于「个人资料」正下方',
      !!entry &&
        document.getElementById('user-menu-button-profile')
          .nextElementSibling === entry,
    );

    entry.click();
    await sleep(300);
    assert(
      '点击入口激活管理视图（原生内容隐藏）',
      document.querySelector('.panel-body-contents')?.dataset.lkcbView ===
        'rules' &&
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
        .hasAttribute('data-lkcb-view') && !entry.classList.contains('active'),
    );

    entry.click();
    await sleep(200);

    // ◆ 规则数据
    // 等类别树异步就绪（/site.json 拉取：picker 下拉打开后出现「不按类别筛选」
    // 以外的选项），否则类别规则的行文本会显示数字 ID 而非类别名
    let treeReady = false;
    for (let i = 0; i < 10 && !treeReady; i++) {
      formPicker().querySelector('.lkcb-cat-input').focus();
      await sleep(500);
      treeReady =
        formPicker().querySelectorAll(
          '.lkcb-cat-item[data-id]:not([data-id=""])',
        ).length > 0;
      formPicker().querySelector('.lkcb-cat-input').blur();
      await sleep(50);
    }
    const chips1 = viewChips();
    assert(
      '旧关键词存储迁移为仅标题规则并规范化（trim/去重/滤空）',
      JSON.stringify(chips1) ===
        JSON.stringify(['标题:夸克', '标题:ASTRO', '标题:红包']),
      JSON.stringify(chips1),
    );

    await addRuleViaUI('11', '新标签 ', ' 新标题');
    const chips2 = viewChips();
    assert(
      'UI 添加组合规则（trim + 类别展示名入行文本，有子分类的类别带「不带等级」后缀）',
      chips2.length === 4 &&
        chips2[3] === '类别:搞七捻三（不带等级） + 标签:新标签 + 标题:新标题',
      JSON.stringify(chips2),
    );

    document
      .querySelector(
        '.panel-body-contents #lkcb-quick-access ul.lkcb-rules li:last-child button.lkcb-remove',
      )
      .click();
    await sleep(200);
    assert('× 删除规则', viewChips().length === 3, JSON.stringify(viewChips()));

    await addRuleViaUI('', '   ', '');
    assert(
      '三项全空不添加',
      viewChips().length === 3,
      JSON.stringify(viewChips()),
    );

    document.getElementById('lkcb-clear').click();
    await sleep(200);
    assert(
      '清空全部规则并还原行状态',
      viewChips().length === 0 && mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );

    // ◆ 类别选择器（树此时已就绪，见前文等待循环）
    const pickerInput = formPicker().querySelector('.lkcb-cat-input');
    pickerInput.focus(); // 打开全量下拉
    await sleep(100);
    const fullCount = formPicker().querySelectorAll(
      '.lkcb-cat-item[data-id]',
    ).length;
    pickerInput.value = '开发调优';
    pickerInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    const filteredItems = [
      ...formPicker().querySelectorAll('.lkcb-cat-item[data-id]'),
    ];
    const sub = filteredItems.filter((el) => el.dataset.id !== '');
    assert(
      '类别选择器：输入即过滤下拉项',
      fullCount > 1 &&
        sub.length > 0 &&
        sub.length < fullCount - 1 &&
        sub.every((el) => el.textContent.includes('开发调优')),
      `${filteredItems.length}/${fullCount}`,
    );
    // 点选「开发调优, Lv2」→ 输入框显示类别名、出现清除按钮
    //（site.json 的子分类 name 自带「父分类, 等级」逗号格式，实测 2026-09）
    const lv2 = sub.find((el) => el.textContent.includes('Lv2'));
    lv2.click();
    await sleep(100);
    assert(
      '类别选择器：点选后显示类别名、出现清除按钮',
      pickerInput.value === '开发调优, Lv2' &&
        !formPicker().querySelector('.lkcb-cat-clear').hidden,
      pickerInput.value,
    );
    formPicker().querySelector('.lkcb-cat-clear').click();
    await sleep(100);
    assert(
      '类别选择器：× 清除恢复未选状态',
      pickerInput.value === '' &&
        formPicker().querySelector('.lkcb-cat-clear').hidden,
      pickerInput.value,
    );

    // ◆ 匹配算法：先铺三条仅标题规则（迁移产物等价物）
    await addRuleViaUI('', '', '夸克');
    await addRuleViaUI('', '', 'ASTRO');
    await addRuleViaUI('', '', '红包');
    let st = mockStates();
    assert(
      '标题规则命中隐藏（大小写归一化）',
      st[1] === 'hidden' && st[2] === 'hidden' && !st[3] && !st[4],
      JSON.stringify(st),
    );
    assert(
      '置顶帖标题命中隐藏（回归：空置顶按钮不影响标题提取）',
      st[0] === 'hidden',
      JSON.stringify(st),
    );

    // 类别规则：仅选类别（11 = 搞七捻三，徽章在 mock 行的 data-category-id 上）
    await addRuleViaUI('11', '', '');
    st = mockStates();
    assert(
      '类别规则按 data-category-id 命中',
      st[3] === 'hidden',
      JSON.stringify(st),
    );

    // 类别精确匹配：只认所选分类自身的徽章 ID。选父分类（4 = 开发调优）
    // 只命中直接发在该分类下的帖子（不带等级），子分类（20 = 开发调优 Lv1）的
    // 行不受影响；要屏蔽某一级就单独选那一级
    await addRuleViaUI('4', '', '');
    st = mockStates();
    assert(
      '类别精确匹配：父分类规则命中本分类行，不连带子分类行',
      st[4] === 'hidden' && st[5] !== 'hidden',
      JSON.stringify(st),
    );
    document
      .querySelector(
        '.panel-body-contents #lkcb-quick-access ul.lkcb-rules li:last-child button.lkcb-remove',
      )
      .click();
    await sleep(200);
    await addRuleViaUI('20', '', '');
    st = mockStates();
    assert(
      '类别精确匹配：子分类规则只命中该子分类行',
      st[5] === 'hidden' && st[4] !== 'hidden',
      JSON.stringify(st),
    );
    document
      .querySelector(
        '.panel-body-contents #lkcb-quick-access ul.lkcb-rules li:last-child button.lkcb-remove',
      )
      .click();
    await sleep(200);

    // 标签规则：仅填标签
    await addRuleViaUI('', '人工智能', '');
    st = mockStates();
    assert(
      '标签规则按 discourse-tag 文本精确命中',
      st[4] === 'hidden',
      JSON.stringify(st),
    );

    // 标签精确语义反向验证：行内标签是「人工智能」，规则填子串「人工」不得命中
    document.getElementById('lkcb-clear').click();
    await sleep(200);
    await addRuleViaUI('', '人工', '');
    st = mockStates();
    assert(
      '标签规则精确匹配：子串不命中',
      st.every((s) => !s),
      JSON.stringify(st),
    );

    // 组合规则 AND 语义：标签命中但标题不命中 → 不隐藏
    document.getElementById('lkcb-clear').click();
    await sleep(200);
    await addRuleViaUI('', '人工智能', '不存在的标题词');
    st = mockStates();
    assert(
      '组合规则 AND：仅标签命中不隐藏',
      st.every((s) => !s),
      JSON.stringify(st),
    );
    await addRuleViaUI('', '人工智能', 'another');
    st = mockStates();
    assert(
      '组合规则 AND：标签+标题都命中才隐藏',
      st[4] === 'hidden' && st[1] !== 'hidden',
      JSON.stringify(st),
    );

    // 三字段 AND（如「福利羊毛 + 高级推广 + 标题词」场景）：任一字段不命中不隐藏
    document.getElementById('lkcb-clear').click();
    await sleep(200);
    await addRuleViaUI('4', '人工智能', 'another');
    st = mockStates();
    assert(
      '组合规则 AND：类别+标签+标题全命中才隐藏',
      st[4] === 'hidden' && st[1] !== 'hidden' && st[2] !== 'hidden',
      JSON.stringify(st),
    );

    // ◆ 处理模式与开关
    const sel = document.getElementById('lkcb-hideMode');
    sel.value = 'dim';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    st = mockStates();
    assert('淡化模式生效', st[4] === 'dimmed', JSON.stringify(st));
    sel.value = 'hide';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);

    document.getElementById('lkcb-enabled').click();
    await sleep(200);
    assert(
      '关闭屏蔽清空所有行状态',
      mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );
    document.getElementById('lkcb-enabled').click();
    await sleep(200);
    assert(
      '重新开启后恢复隐藏',
      mockStates()[4] === 'hidden',
      JSON.stringify(mockStates()),
    );

    // ◆ 单规则启停：总开关打开时，停用的规则不参与匹配
    const firstRuleCheck = () =>
      document.querySelector(
        '.panel-body-contents #lkcb-rules li input[type="checkbox"]',
      );
    firstRuleCheck().click();
    await sleep(200);
    st = mockStates();
    assert(
      '单规则停用：总开关开着也不生效（勾选态同步）',
      st.every((s) => !s) && !firstRuleCheck().checked,
      JSON.stringify(st),
    );
    firstRuleCheck().click();
    await sleep(200);
    st = mockStates();
    assert(
      '单规则重新启用：恢复生效',
      st[4] === 'hidden' && firstRuleCheck().checked,
      JSON.stringify(st),
    );

    // ◆ 行内编辑：原行下方展开与添加同款表单，原位保存/取消
    const firstRow = () =>
      document.querySelector('.panel-body-contents #lkcb-rules li');
    firstRow().querySelector('button.lkcb-edit').click();
    await sleep(200);
    let editForm = firstRow().querySelector('.lkcb-rule-edit');
    assert(
      '行内编辑展开：类别 picker 显示类别名 + 标签标题原值回填',
      !!editForm &&
        editForm.querySelector('.lkcb-cat-input').value ===
          '开发调优（不带等级）' &&
        editForm.querySelector('.lkcb-edit-tag').value === '人工智能' &&
        editForm.querySelector('.lkcb-edit-title').value === 'another',
      JSON.stringify({
        cat: editForm?.querySelector('.lkcb-cat-input')?.value,
        tag: editForm?.querySelector('.lkcb-edit-tag')?.value,
        title: editForm?.querySelector('.lkcb-edit-title')?.value,
      }),
    );
    editForm.querySelector('.lkcb-edit-title').value = '改后的标题';
    editForm.querySelector('.lkcb-save').click();
    await sleep(200);
    assert(
      '保存修改：原位替换 + 表单收起',
      viewChips().length === 1 &&
        viewChips()[0].includes('改后的标题') &&
        !firstRow().querySelector('.lkcb-rule-edit'),
      JSON.stringify(viewChips()),
    );
    firstRow().querySelector('button.lkcb-edit').click();
    await sleep(200);
    editForm = firstRow().querySelector('.lkcb-rule-edit');
    editForm.querySelector('.lkcb-edit-title').value = '不该被保存';
    // 真实输入会触发 input 事件（程序化赋值不触发，必须手动派发）
    editForm
      .querySelector('.lkcb-edit-title')
      .dispatchEvent(new Event('input', { bubbles: true }));
    editForm.querySelector('.lkcb-cancel-edit').click();
    await sleep(200);
    assert(
      '取消编辑：保持上次保存值并丢弃未保存输入 + 表单收起',
      viewChips().length === 1 &&
        viewChips()[0].includes('改后的标题') &&
        !viewChips()[0].includes('不该被保存') &&
        !firstRow().querySelector('.lkcb-rule-edit'),
      JSON.stringify(viewChips()),
    );

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

    // 重新激活管理视图（销毁重建后的入口仍可用）
    document.getElementById('lkcb-menu-entry').click();
    await sleep(200);
    assert(
      '重新点击入口再次激活管理视图',
      document.querySelector('.panel-body-contents')?.dataset.lkcbView ===
        'rules',
    );

    // ◆ 健壮性：存储损坏回退已移至运行流程的独立阶段
    // （刷新页面 → 预写坏 JSON → 注入 → 断言零报错；页内二次 eval 会被站点 CSP 间歇性拦截）

    // 全程零 JS 错误
    assert('全程零 JS 错误', pageErrors.length === 0, pageErrors.join('; '));
  } catch (e) {
    const msg = String((e && e.stack) || e).slice(0, 400);
    failures.push('异常中断: ' + msg);
    results.push({
      name: '异常中断（后续断言未执行）',
      ok: false,
      detail: msg,
    });
    console.error('[lkcb-test] 测试异常中断:', e);
  } finally {
    // —— 清理 ——
    document.getElementById('blocker-test-mock')?.remove();
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);

    // —— 输出 ——
    console.log(
      '%c[lkcb-test] ' + passed + '/' + results.length + ' 通过',
      'font-weight:bold;color:' + (failures.length ? 'red' : 'green'),
    );
    results.forEach((r, i) =>
      console.log(
        (r.ok ? '✅ ' : '❌ ') +
          (i + 1) +
          '. ' +
          r.name +
          (r.ok ? '' : ' —— ' + r.detail),
      ),
    );
    if (failures.length === 0)
      console.log(
        '全部通过。mock DOM 与存储已清理；刷新页面即可恢复干净状态。',
      );
    window.__lkcbTestResults = results;
    window.__lkcbTestsRunning = false;
  }
})();
