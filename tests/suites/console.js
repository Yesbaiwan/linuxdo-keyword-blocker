/* eslint-disable */
// 功能回归：登录门槛 / 面板开关（菜单命令、Ctrl+Q 开；Esc、×、遮罩关）/ 规则 CRUD /
// 类别下拉（等级顺序、展开候选不撑高面板、拉不到时的提示与重试）/ 标签框增删与「零标签」收起 /
// 匹配语义（类别精确、所有等级、标签精确、多标签 AND、零标签、标题包含、大小写不敏感、
// 组合 AND、搜索页嵌套行）/ 启停 / 行内编辑 / 导入 / 存储损坏回退。自建 mock DOM 隔离运行，
// 不依赖真实站点内容。
// 由 tests/run.js 注入到专用 Chrome profile 页面里跑；结果挂 window.__lkcbTestResults
//（__lkcbTestsRunning 为结束标志），并 POST 回 tests/serve.js。

(async function () {
  if (window.__lkcbTestsRunning) return console.warn('[lkcb-test] 已在运行中');
  window.__lkcbTestsRunning = true;

  const STORE_KEY = 'linuxdo-keyword-blocker-settings';
  const origStore = localStorage.getItem(STORE_KEY);
  // 只统计「我们自己的」报错：「Script error.」是不透明错误，只有跨域脚本（站点 CDN / Turnstile）才会长这样；
  // 我们注入的脚本不是跨域，真报错必然带真实 message
  const pageErrors = [];
  const opaque = (s) => {
    const t = String(s ?? '').trim();
    return !t || t === 'Script error.' || t === 'Script error';
  };
  const recordError = (msg, prefix = '') => {
    if (!opaque(msg)) pageErrors.push(prefix + String(msg));
  };
  window.addEventListener('error', (e) => recordError(e.message));
  window.addEventListener('unhandledrejection', (e) =>
    recordError((e.reason && e.reason.message) || e.reason, 'rejection: '),
  );

  const source = window.__LKCB_SOURCE__;
  if (!source) {
    console.error(
      '[lkcb-test] 缺少被测脚本源码：请先注入 window.__LKCB_SOURCE__。',
    );
    window.__lkcbTestsRunning = false;
    return;
  }

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

  // 结果推回本地 serve.js（落盘 + 一行摘要）：看结果不必再把全量断言数组搬回来
  const report = () =>
    navigator.sendBeacon?.(
      'http://127.0.0.1:8123/__result',
      JSON.stringify({
        suite: 'console',
        passed,
        total: results.length,
        failures: results.filter((r) => !r.ok),
        results, // 全量明细只落盘 tests/.last-result.json，终端只打一行摘要
      }),
    );

  // mock DOM：仿 linux.do 头部（登录态看 #current-user）、话题列表表格与搜索结果块。
  // 行内带类别徽章（data-category-id）与标签（a.discourse-tag）。
  // 面板（#lkcb-overlay）由脚本挂在 body 上，不属于 mock。
  // 首页 7 行 + 1 个搜索结果块（.fps-result 内层再套一层 [data-topic-id]，验证嵌套行处理）
  function buildMock(loggedIn = true) {
    document.getElementById('blocker-test-mock')?.remove();
    const mock = document.createElement('div');
    mock.id = 'blocker-test-mock';
    // prettier-ignore
    mock.innerHTML = `
      <div class="d-header"><ul class="header-buttons">${loggedIn ? '<li id="current-user" class="header-dropdown-toggle"></li>' : ''}</ul></div>
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
          <td><span class="badge-category" data-category-id="999" data-test-role="child"><span class="badge-category__name">子分类</span></span></td>
        </tr>
        <tr class="topic-list-item">
          <td><a class="title" href="/t/topic/7">双标签共存帖</a></td>
          <td><a class="discourse-tag" href="/tag/人工智能">人工智能</a><a class="discourse-tag" href="/tag/纯水">纯水</a></td>
          <td><span class="badge-category" data-category-id="4"><span class="badge-category__name">开发调优</span></span></td>
        </tr>
      </tbody></table>
      <div class="fps-result" data-topic-id="8">
        <a class="topic-title" href="/t/topic/8">搜索结果里的夸克帖</a>
        <span class="badge-category" data-category-id="4"><span class="badge-category__name">开发调优</span></span>
        <div data-topic-id="8"><span class="fps-snippet">内层嵌套行</span></div>
      </div>`;
    document.body.appendChild(mock);
    return mock;
  }

  const mockRows = () => [
    ...document.querySelectorAll('#blocker-test-mock tr.topic-list-item'),
  ];
  const mockStates = () =>
    mockRows().map((r) => r.getAttribute('data-lkcb-state'));
  const searchRow = () =>
    document.querySelector('#blocker-test-mock .fps-result');
  const searchInner = () =>
    document.querySelector('#blocker-test-mock .fps-result [data-topic-id]');

  // —— 面板与表单的查询助手 ——
  const overlay = () => document.getElementById('lkcb-overlay');
  const isOpen = () => !!overlay()?.classList.contains('lkcb-open');
  const addForm = () => document.getElementById('lkcb-add-form');
  const rules = () => [...document.querySelectorAll('#lkcb-rules li')];
  const chips = () =>
    [...document.querySelectorAll('#lkcb-rules .lkcb-rule-text')].map(
      (s) => s.textContent,
    );
  const lastRule = () => rules().at(-1);
  const picker = () => addForm().querySelector('.lkcb-cat-picker');
  const tagBoxes = (scope = addForm()) => [
    ...scope.querySelectorAll('.lkcb-tag-input'),
  ];
  const tagRemoves = (scope = addForm()) => [
    ...scope.querySelectorAll('.lkcb-tag-remove'),
  ];
  const tagBoxEls = (scope = addForm()) => [
    ...scope.querySelectorAll('.lkcb-tag-box'),
  ];
  const statusText = () => document.getElementById('lkcb-status').textContent;

  const keyEvent = (key, ctrl = false) =>
    new KeyboardEvent('keydown', {
      key,
      ctrlKey: ctrl,
      bubbles: true,
      cancelable: true,
    });

  // 按真实路径操作类别下拉：聚焦展开 → 点选目标项（含「所有等级」）
  async function pickCategory(id, allLevels) {
    const input = picker().querySelector('.lkcb-cat-input');
    input.focus();
    await sleep(120);
    const sel = allLevels
      ? `.lkcb-cat-item[data-all-levels="1"][data-id="${id}"]`
      : `.lkcb-cat-item[data-id="${id}"]:not([data-all-levels])`;
    picker().querySelector(sel).click();
    await sleep(80);
  }

  // 按界面路径添加一条规则：类别 + 标签（可多个，逗号分隔）+ 标题 + 零标签
  async function addRule(categoryId, tags, title, opts = {}) {
    if (categoryId) await pickCategory(categoryId, opts.allLevels);
    else picker().querySelector('.lkcb-cat-clear').click();
    const noTag = addForm().querySelector('.lkcb-notag');
    if (opts.noTag) {
      noTag.checked = true;
      noTag.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const want = String(tags || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    while (tagBoxes().length < want.length)
      addForm().querySelector('.lkcb-tag-add').click();
    tagBoxes().forEach((el, i) => {
      el.value = want[i] || '';
    });
    addForm().querySelector('.lkcb-title').value = title || '';
    document.getElementById('lkcb-add').click();
    await sleep(200);
  }

  const clearRules = async () => {
    document.getElementById('lkcb-clear').click();
    await sleep(200);
  };

  try {
    // —— 准备：坏存储（验证回退）+ 未登录 + 注入，必须保持在首个 await 之前 ——
    localStorage.setItem(STORE_KEY, '{坏掉的 JSON');
    // 强制走真实拉取（别吃到上轮留下的 7 天缓存），并先让 /site.json 失败：
    // 验「拉不到 → 状态行提示 + 下拉给重试入口 → 点重试真能拉回来」
    localStorage.removeItem('linuxdo-keyword-blocker-categories');
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      return url.includes('/site.json')
        ? Promise.reject(new Error('blocked-for-test'))
        : realFetch.call(window, input, init);
    };
    window.GM = {
      getValue: (k, d) => Promise.resolve(localStorage.getItem(k) ?? d),
      setValue: (k, v) => {
        localStorage.setItem(k, v);
        return Promise.resolve();
      },
    };
    window.GM_registerMenuCommand = (title, fn) => {
      window.__lkcbMenuCommand = fn; // 脚本经此注册打开面板的菜单命令
    };
    // 真实页面可能已登录，而脚本看的是整个 document 的 #current-user：
    // 先改掉真实头部的 id 模拟未登录，断言后恢复即等效 SPA 登录
    const realUser = document.getElementById('current-user');
    if (realUser) realUser.id = 'current-user-lkcb-suspended';
    buildMock(false);
    (0, eval)(source);
    await sleep(400);

    // ◆ 登录门槛
    assert(
      '未登录不启动：无面板、不过滤',
      !overlay() && mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );
    if (realUser) {
      realUser.id = 'current-user';
      document.body.appendChild(document.createComment('lkcb-login-probe'));
    } else {
      document
        .querySelector('#blocker-test-mock .header-buttons')
        .insertAdjacentHTML('beforeend', '<li id="current-user"></li>');
    }
    await sleep(600);
    assert(
      '登录后启动：面板注入且默认隐藏 + 坏存储回退默认（0 规则、已启用）',
      !!overlay() &&
        !isOpen() &&
        mockStates().every((s) => !s) &&
        document.getElementById('lkcb-status').textContent ===
          '已启用，还没有规则',
      document.getElementById('lkcb-status').textContent,
    );

    // ◆ 面板开关：菜单命令 / Ctrl+Q 开，Esc / × / 遮罩关
    window.__lkcbMenuCommand?.();
    await sleep(100);
    assert(
      '菜单命令打开面板',
      typeof window.__lkcbMenuCommand === 'function' && isOpen(),
    );
    document.dispatchEvent(keyEvent('Escape'));
    await sleep(100);
    assert('Esc 关闭面板', !isOpen());
    document.dispatchEvent(keyEvent('q', true));
    await sleep(100);
    assert('Ctrl+Q 打开面板（后续保持开启）', isOpen());

    // ◆ 类别列表拉不到：重试 3 次仍失败 → 状态行提示 + 下拉给重试入口，点它重新拉
    await sleep(3200); // 等脚本把 3 次重试（0.8s + 1.6s）走完
    assert(
      '类别列表拉不到：状态行提示',
      statusText().includes('类别列表没拉到'),
      statusText(),
    );
    const offlineInput = picker().querySelector('.lkcb-cat-input');
    offlineInput.focus();
    await sleep(150);
    const retryItem = picker().querySelector('.lkcb-cat-item[data-retry]');
    assert(
      '类别列表拉不到：下拉给「点此重试」',
      !!retryItem && retryItem.textContent.includes('重试'),
      retryItem?.textContent,
    );
    window.fetch = realFetch; // 恢复网络，验证重试真能拉回来
    retryItem?.click();
    await sleep(800);
    assert(
      '点重试后：类别树拉到、状态行提示消失',
      !statusText().includes('类别列表没拉到') &&
        picker().querySelectorAll('.lkcb-cat-item[data-id]:not([data-id=""])')
          .length > 0,
      statusText(),
    );
    offlineInput.blur();
    await sleep(100);

    // ◆ 等类别树就绪（/site.json，picker 出现真实分类项）
    let treeReady = false;
    for (let i = 0; i < 12 && !treeReady; i++) {
      const input = picker().querySelector('.lkcb-cat-input');
      input.focus();
      await sleep(400);
      treeReady =
        picker().querySelectorAll('.lkcb-cat-item[data-id]:not([data-id=""])')
          .length > 0;
      input.blur();
      await sleep(50);
    }
    assert('类别树就绪：下拉出现真实分类', treeReady);
    // 从真实树取展示名（不带等级那条）与「开发调优」的第一个等级子分类 ID，避免硬编码
    picker().querySelector('.lkcb-cat-input').focus();
    await sleep(150);
    const catItems = [...picker().querySelectorAll('.lkcb-cat-item[data-id]')];
    const nameOf = (id) =>
      catItems
        .filter((el) => el.dataset.id === id)
        .find((el) => el.dataset.allLevels !== '1')?.textContent;
    const cat4Name = nameOf('4');
    const cat11Name = nameOf('11');
    // 等级顺序：所有等级 → 不带等级 → 等级子分类
    const idx4 = catItems.findIndex(
      (el) => el.dataset.id === '4' && el.dataset.allLevels === '1',
    );
    const plain4 = catItems[idx4 + 1];
    const orderOk =
      idx4 >= 0 &&
      plain4?.dataset.id === '4' &&
      !plain4.dataset.allLevels &&
      plain4.textContent.includes('不带等级');
    const childId =
      idx4 >= 0
        ? catItems
            .slice(idx4 + 2)
            .find((el) => el.dataset.id && el.dataset.id !== '4')?.dataset.id
        : undefined;
    picker().querySelector('.lkcb-cat-input').blur();
    await sleep(80);
    assert(
      '类别树可用：取到分类展示名与其子分类 ID',
      !!cat4Name && !!cat11Name && !!childId,
      `${cat4Name} / ${cat11Name} / child=${childId}`,
    );
    assert(
      '类别下拉顺序：所有等级 → 不带等级 → 等级子分类',
      orderOk,
      JSON.stringify(
        catItems.slice(idx4, idx4 + 3).map((el) => el.textContent),
      ),
    );
    mockRows()[5]
      .querySelector('[data-test-role="child"]')
      .setAttribute('data-category-id', childId);

    // ◆ 规则 CRUD
    await addRule('11', '新标签', ' 新标题');
    assert(
      '添加组合规则：trim + 类别展示名 + 行文本完整',
      chips().length === 1 &&
        chips()[0] === `类别:${cat11Name} + 标签:新标签 + 标题:新标题`,
      JSON.stringify(chips()),
    );
    assert(
      '规则行数与状态行同步：1 条规则生效',
      rules().length === 1 && statusText() === '已启用，1/1 条规则生效',
      JSON.stringify({ rows: rules().length, status: statusText() }),
    );
    lastRule().querySelector('.lkcb-remove').click();
    await sleep(200);
    assert('× 删除规则', chips().length === 0, JSON.stringify(chips()));
    await addRule('', '   ', '');
    assert('三项全空不添加', chips().length === 0, JSON.stringify(chips()));

    // ◆ 标签框：点「+」增设、上限 3、每框可 × 移除、零标签时整行收起
    assert(
      '标签框：默认 1 个且「+」可见，仅剩 1 个时不给删除按钮',
      tagBoxes().length === 1 &&
        !addForm().querySelector('.lkcb-tag-add').hidden &&
        tagRemoves()[0].hidden,
    );
    addForm().querySelector('.lkcb-tag-add').click();
    addForm().querySelector('.lkcb-tag-add').click();
    await sleep(80);
    assert(
      '标签框：增至 3 个后「+」隐藏，每框都有可见的删除按钮',
      tagBoxes().length === 3 &&
        addForm().querySelector('.lkcb-tag-add').hidden &&
        tagRemoves().every((b) => !b.hidden),
      `${tagBoxes().length} 个框`,
    );
    tagBoxes()[0].value = '会被移除';
    tagRemoves()[1].click();
    await sleep(80);
    assert(
      '标签框：× 只移除对应的那个框，其余框内容保留',
      tagBoxes().length === 2 &&
        tagBoxes().some((el) => el.value === '会被移除'),
      JSON.stringify(tagBoxes().map((el) => el.value)),
    );
    // ◆ 「零标签」与标签框同一行；勾选后框与「+」收起、复选框本身保留
    const noTagBox = addForm().querySelector('.lkcb-notag');
    const sameRow = !!noTagBox.closest('.lkcb-tags');
    noTagBox.checked = true;
    noTagBox.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
    const boxesHidden = tagBoxEls().every(
      (el) => el.hidden && el.getBoundingClientRect().height === 0,
    );
    const addHidden = addForm().querySelector('.lkcb-tag-add').hidden;
    const noTagVisible =
      !noTagBox.hidden &&
      noTagBox.closest('label').getBoundingClientRect().height > 0;
    noTagBox.checked = false;
    noTagBox.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
    const restored =
      tagBoxes().every((el) => !el.hidden) &&
      !addForm().querySelector('.lkcb-tag-add').hidden;
    assert(
      '标签框：勾选「零标签」框与「+」收起（复选框留在标签行），取消后恢复',
      sameRow && boxesHidden && addHidden && noTagVisible && restored,
      JSON.stringify({
        sameRow,
        boxesHidden,
        addHidden,
        noTagVisible,
        restored,
      }),
    );

    // ◆ 类别下拉：输入过滤 / 点选回填 / × 清除 / 箭头开合
    const catInput = picker().querySelector('.lkcb-cat-input');
    const catList = picker().querySelector('.lkcb-cat-list');
    const panelEl = document.getElementById('lkcb-panel');
    const heightClosed = Math.round(panelEl.getBoundingClientRect().height);
    catInput.focus();
    await sleep(120);
    // 候选列表是浮层：展开不能改变面板高度，否则整块面板被撑高、页面跳动
    assert(
      '类别下拉：展开候选列表不撑高面板',
      !catList.hidden &&
        Math.round(panelEl.getBoundingClientRect().height) === heightClosed,
      JSON.stringify({
        closed: heightClosed,
        open: Math.round(panelEl.getBoundingClientRect().height),
      }),
    );
    const fullCount = picker().querySelectorAll(
      '.lkcb-cat-item[data-id]',
    ).length;
    catInput.value = '开发调优';
    catInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    const filtered = [...picker().querySelectorAll('.lkcb-cat-item[data-id]')];
    const realItems = filtered.filter((el) => el.dataset.id);
    assert(
      '类别下拉：输入即过滤',
      fullCount > 1 &&
        realItems.length > 0 &&
        realItems.length < fullCount - 1 &&
        realItems.every((el) => el.textContent.includes('开发调优')),
      `${realItems.length}/${fullCount}`,
    );
    const childItem =
      realItems.find((el) => el.dataset.id === childId) || realItems[0];
    childItem.click();
    await sleep(120);
    assert(
      '类别下拉：点选后回填展示名并出现清除按钮',
      catInput.value === childItem.textContent &&
        !picker().querySelector('.lkcb-cat-clear').hidden,
      catInput.value,
    );
    picker().querySelector('.lkcb-cat-clear').click();
    await sleep(120);
    assert(
      '类别下拉：× 清除恢复未选',
      catInput.value === '' && picker().querySelector('.lkcb-cat-clear').hidden,
    );
    const caret = picker().querySelector('.lkcb-cat-caret');
    catInput.blur();
    await sleep(80);
    const closedBefore = catList.hidden;
    caret.click();
    await sleep(120);
    const openedByCaret = !catList.hidden;
    caret.click();
    await sleep(120);
    assert(
      '类别下拉：箭头点击开合（无需聚焦）',
      closedBefore && openedByCaret && catList.hidden,
    );

    // ◆ 匹配语义：标题（匹配断言统一用「直接隐藏」模式，先切过去）
    const hideMode = document.getElementById('lkcb-hideMode');
    hideMode.value = 'hide';
    hideMode.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    await addRule('', '', '夸克');
    let st = mockStates();
    assert(
      '标题规则：包含即命中（结果页外层行也命中）',
      st[1] === 'hidden' &&
        searchRow().dataset.lkcbState === 'hidden' &&
        !st[3],
      JSON.stringify(st) + ' search=' + searchRow().dataset.lkcbState,
    );
    assert(
      '搜索结果页：状态只打在最外层行，内层嵌套行不带状态',
      !searchInner().hasAttribute('data-lkcb-state'),
    );
    await addRule('', '', '红包');
    assert(
      '置顶帖标题命中（回归：空置顶按钮不影响标题提取）',
      mockStates()[0] === 'hidden',
      JSON.stringify(mockStates()),
    );
    await addRule('', '', 'ASTRO');
    assert(
      '标题规则大小写不敏感：小写标题命中大写关键词',
      mockStates()[2] === 'hidden',
      JSON.stringify(mockStates()),
    );

    // ◆ 匹配语义：类别
    await clearRules();
    await addRule('11', '', '');
    st = mockStates();
    assert(
      '类别规则：按 data-category-id 精确命中本分类',
      st[0] === 'hidden' && st[3] === 'hidden' && !st[1],
      JSON.stringify(st),
    );
    await clearRules();
    await addRule('4', '', '');
    st = mockStates();
    assert(
      '类别精确匹配：父分类不连带子分类',
      st[1] === 'hidden' && st[5] !== 'hidden',
      JSON.stringify(st),
    );
    await clearRules();
    await addRule(childId, '', '');
    st = mockStates();
    assert(
      '类别精确匹配：子分类规则只命中该子分类',
      st[5] === 'hidden' && st[1] !== 'hidden',
      JSON.stringify(st),
    );
    await clearRules();
    await addRule('4', '', '', { allLevels: true });
    st = mockStates();
    assert(
      '所有等级：父类自身 + 等级子类都命中，其他类别不命中',
      st[1] === 'hidden' &&
        st[2] === 'hidden' &&
        st[4] === 'hidden' &&
        st[5] === 'hidden' &&
        st[6] === 'hidden' &&
        st[0] !== 'hidden' &&
        st[3] !== 'hidden',
      JSON.stringify(st),
    );

    // ◆ 匹配语义：标签
    await clearRules();
    await addRule('', '人工智能', '');
    st = mockStates();
    assert(
      '标签规则：按 a.discourse-tag 文本精确命中',
      st[1] === 'hidden' && st[4] === 'hidden' && st[6] === 'hidden' && !st[2],
      JSON.stringify(st),
    );
    await clearRules();
    await addRule('', '人工', '');
    assert(
      '标签规则：子串不命中',
      mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );
    await clearRules();
    await addRule('', '人工智能,纯水', '');
    st = mockStates();
    assert(
      '多标签 AND：需同时存在才命中，只含其一不命中',
      st[6] === 'hidden' &&
        st[1] !== 'hidden' &&
        st[2] !== 'hidden' &&
        st[4] !== 'hidden',
      JSON.stringify(st),
    );

    // ◆ 匹配语义：零标签 / 组合 AND
    await clearRules();
    await addRule('', '', '', { noTag: true });
    st = mockStates();
    assert(
      '零标签约束：只命中不带标签的帖子',
      st[3] === 'hidden' &&
        st[5] === 'hidden' &&
        searchRow().dataset.lkcbState === 'hidden' &&
        !st[0] &&
        !st[1],
      JSON.stringify(st),
    );
    await clearRules();
    await addRule('4', '', '', { allLevels: true, noTag: true });
    st = mockStates();
    assert(
      '所有等级 + 零标签：只命中该大类各级的不带标签帖',
      st[5] === 'hidden' &&
        searchRow().dataset.lkcbState === 'hidden' &&
        st[1] !== 'hidden' &&
        st[3] !== 'hidden',
      JSON.stringify(st),
    );
    await clearRules();
    await addRule('4', '人工智能', 'another');
    st = mockStates();
    assert(
      '组合 AND：类别 + 标签 + 标题全命中才隐藏',
      st[4] === 'hidden' && st[1] !== 'hidden' && st[2] !== 'hidden',
      JSON.stringify(st),
    );

    // ◆ 处理模式与启停
    hideMode.value = 'dim';
    hideMode.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    assert(
      '淡化模式生效',
      mockStates()[4] === 'dimmed',
      JSON.stringify(mockStates()),
    );
    hideMode.value = 'hide';
    hideMode.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const enabledBox = document.getElementById('lkcb-enabled');
    enabledBox.click();
    await sleep(200);
    assert(
      '关闭总开关清空所有行状态',
      mockStates().every((s) => !s),
      JSON.stringify(mockStates()),
    );
    enabledBox.click();
    await sleep(200);
    assert(
      '重新开启后恢复隐藏',
      mockStates()[4] === 'hidden',
      JSON.stringify(mockStates()),
    );
    const ruleCheck = () => rules()[0].querySelector('input[type="checkbox"]');
    ruleCheck().click();
    await sleep(200);
    assert(
      '单规则停用：总开关开着也不生效',
      mockStates().every((s) => !s) && !ruleCheck().checked,
      JSON.stringify(mockStates()),
    );
    ruleCheck().click();
    await sleep(200);
    assert(
      '单规则重新启用：恢复生效',
      mockStates()[4] === 'hidden' && ruleCheck().checked,
    );

    // ◆ 新增行的判定时机：命中规则的探针行（类别 4 + 标签人工智能 + 标题含 another）
    const tbody = document.querySelector('#blocker-test-mock tbody');
    const mkProbe = (id, title) => {
      const tr = document.createElement('tr');
      tr.className = 'topic-list-item';
      tr.dataset.topicId = id;
      tr.innerHTML = `<td><a class="title" href="/t/${id}">${title}</a><span class="badge-category" data-category-id="4"></span><a class="discourse-tag" href="/tag/人工智能">人工智能</a></td>`;
      return tr;
    };
    const probe = mkProbe('900001', '');
    tbody.append(probe);
    await sleep(200);
    const skeletonState = probe.getAttribute('data-lkcb-state');
    probe.querySelector('.title').textContent = 'another 骨架后填充';
    await sleep(200);
    const filledState = probe.getAttribute('data-lkcb-state');
    probe.remove();
    assert(
      '骨架期不命中 → 标题填充后重新判定为命中（缓存不会漏过滤）',
      skeletonState === null && filledState === 'hidden',
      JSON.stringify({ skeletonState, filledState }),
    );
    enabledBox.click();
    await sleep(150);
    const probe2 = mkProbe('900002', 'another 关闭期间插入');
    tbody.append(probe2);
    await sleep(200);
    const offState = probe2.getAttribute('data-lkcb-state');
    enabledBox.click();
    await sleep(200);
    const onState = probe2.getAttribute('data-lkcb-state');
    probe2.remove();
    assert(
      '总开关关闭时插入的行不带状态，重新开启后补上',
      offState === null && onState === 'hidden',
      JSON.stringify({ offState, onState }),
    );

    // ◆ 行内编辑：与添加表单同款的字段，原位保存 / 取消
    const openEdit = async () => {
      rules()[0].querySelector('.lkcb-edit').click();
      await sleep(200);
      return rules()[0].querySelector('.lkcb-rule-edit');
    };
    let edit = await openEdit();
    assert(
      '行内编辑展开：类别名 + 标签 + 标题全部回填',
      !!edit &&
        edit.querySelector('.lkcb-cat-input').value === cat4Name &&
        tagBoxes(edit)[0].value === '人工智能' &&
        edit.querySelector('.lkcb-title').value === 'another',
      JSON.stringify({
        cat: edit?.querySelector('.lkcb-cat-input')?.value,
        tags: edit ? tagBoxes(edit).map((el) => el.value) : null,
        title: edit?.querySelector('.lkcb-title')?.value,
      }),
    );
    assert(
      '行内编辑：字段结构与添加表单一致（类别/标签/标题/操作 四行）',
      edit.children.length === addForm().children.length &&
        [...edit.children].every(
          (row, i) => row.className === addForm().children[i].className,
        ),
      JSON.stringify([...edit.children].map((r) => r.className)),
    );
    edit.querySelector('.lkcb-save').click();
    await sleep(200);
    assert(
      '保存修改：原位替换 + 表单收起',
      chips().length === 1 && !rules()[0].querySelector('.lkcb-rule-edit'),
      JSON.stringify(chips()),
    );
    edit = await openEdit();
    edit.querySelector('.lkcb-title').value = '不该被保存';
    edit.querySelector('.lkcb-cancel-edit').click();
    await sleep(200);
    assert(
      '取消编辑：丢弃未保存输入 + 表单收起',
      chips().length === 1 &&
        !chips()[0].includes('不该被保存') &&
        !rules()[0].querySelector('.lkcb-rule-edit'),
      JSON.stringify(chips()),
    );
    // ◆ 导入：与导出同格式的规则数组（去重去空），非法内容给提示且不动现有规则
    const fileInput = document.querySelector(
      '#lkcb-overlay input[type="file"]',
    );
    const importFile = async (text) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([text], 'rules.json', { type: 'application/json' }),
      );
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change'));
      await sleep(300);
    };
    await importFile(
      JSON.stringify([
        {
          category: 11,
          tags: [],
          noTag: false,
          title: '导入标题',
          enabled: true,
        },
        {
          category: 11,
          tags: [],
          noTag: false,
          title: '导入标题',
          enabled: true,
        },
        {
          category: 4,
          allLevels: true,
          tags: ['人工智能'],
          noTag: false,
          title: '',
          enabled: false,
        },
        {
          category: 14,
          allLevels: true,
          tags: [],
          noTag: true,
          title: '',
          enabled: true,
        },
        { category: null, tags: [], noTag: false, title: '', enabled: true },
      ]),
    );
    assert(
      '导入：去重去空后落库，且 allLevels / noTag / enabled 字段完整保留',
      chips().length === 3 &&
        chips()[0] === `类别:${cat11Name} + 标题:导入标题` &&
        chips()[1].includes('所有等级') &&
        chips()[2].includes('所有等级') &&
        chips()[2].includes('零标签') &&
        rules()[1].classList.contains('lkcb-off'),
      JSON.stringify(chips()),
    );
    await importFile('{ 这不是 JSON');
    assert(
      '导入：非法 JSON 给提示且不动现有规则',
      statusText().includes('导入失败') && chips().length === 3,
      statusText(),
    );
    // ◆ 规则集文件本身：≥20 条，且每条都能被归一化保留（没有全空/重复的废项）
    const sampleText = (() => {
      const x = new XMLHttpRequest();
      x.open(
        'GET',
        'http://127.0.0.1:8123/tests/fixtures/rules-sample.json',
        false,
      );
      x.send(null);
      return x.responseText;
    })();
    const sample = JSON.parse(sampleText);
    await importFile(sampleText);
    assert(
      '规则集文件：≥20 条且导入后一条不少',
      sample.length >= 20 && chips().length === sample.length,
      `${sample.length} 条 → ${chips().length} 行`,
    );

    await openEdit();
    document.getElementById('lkcb-close').click();
    await sleep(120);
    assert('× 关闭面板', !isOpen());
    document.dispatchEvent(keyEvent('q', true));
    await sleep(200);
    assert(
      '关闭再打开：编辑态复位（不再有展开的编辑表单）',
      isOpen() && !rules()[0].querySelector('.lkcb-rule-edit'),
    );
    // 遮罩空白处点击关闭
    overlay().click();
    await sleep(120);
    assert('点遮罩空白关闭面板', !isOpen());
    document.dispatchEvent(keyEvent('q', true));
    await sleep(150);

    // ◆ 清空
    document.getElementById('lkcb-clear').click();
    await sleep(200);
    assert(
      '清空按钮：规则清零 + 状态行复位 + 空态提示',
      chips().length === 0 &&
        statusText() === '已启用，还没有规则' &&
        !document.getElementById('lkcb-empty').hidden,
      `${chips().length} 条 / ${statusText()}`,
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
    console.error('[lkcb-test] 测试异常中断:', e);
  } finally {
    document.getElementById('blocker-test-mock')?.remove();
    overlay()?.classList.remove('lkcb-open');
    if (origStore === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, origStore);

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
    if (!failures.length)
      console.log(
        '全部通过。mock DOM 与存储已清理；刷新页面即可恢复干净状态。',
      );
    report();
    window.__lkcbTestResults = results;
    window.__lkcbTestsRunning = false;
  }
})();
