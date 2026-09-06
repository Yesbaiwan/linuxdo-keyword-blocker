// ==UserScript==
// @name         Linux.do Keyword Blocker
// @namespace    https://linux.do/
// @version      2.1
// @description  用关键词屏蔽 linux.do 上不想看到的帖子
// @author       linuxdo-keyword-blocker
// @match        https://linux.do/*
// @homepageURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker
// @downloadURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @updateURL    https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'linuxdo-keyword-blocker-settings';
  const DEFAULT_SETTINGS = {
    enabled: true,
    keywords: [],
    hideMode: 'hide',
  };

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  // 「屏蔽词」标签当前是否处于激活状态（头像菜单内容区切换到关键词管理视图）
  let keywordTabActive = false;

  const TOPIC_SELECTORS = [
    '.fps-result',
    'tr.topic-list-item',
    '.latest-topic-list-item',
    '.topic-list-item',
    '.topic-post',
    '[data-topic-id]',
  ].join(',');

  const TITLE_SELECTORS = [
    '.title',
    '.main-link a',
    '.topic-title',
    '.raw-topic-link',
    'a.title',
    "a[href^='/t/']",
  ].join(',');

  // 登录后点击右上角头像出现的用户菜单；未登录时不存在，因此无入口
  const USER_MENU_PANEL_SELECTOR = '.user-menu.menu-panel';
  // 入口做成和「个人资料」同款的标签按钮，插在它下面（标签列最底部）
  const PROFILE_TAB_ID = 'user-menu-button-profile';
  const MENU_TABS_FALLBACK_SELECTOR = '.user-menu.menu-panel .menu-tabs-container';
  // 这些节点被移除意味着整个菜单面板被销毁（关闭）
  const MENU_CLOSE_MARKERS = '.user-menu.menu-panel, .user-menu-dropdown-wrapper';

  // ===== storage =====

  async function loadSettings() {
    const stored = await GM.getValue(STORAGE_KEY, null);
    let parsed = {};
    try {
      if (stored) parsed = JSON.parse(stored);
    } catch (e) {
      // 存储内容损坏时保持空对象，回退默认设置，别让整个脚本挂掉
    }
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keywords: normalizeKeywords(parsed.keywords),
    };
    refreshKeywordCache();
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    settings.keywords = normalizeKeywords(settings.keywords);
    refreshKeywordCache();
    await GM.setValue(STORAGE_KEY, JSON.stringify(settings));
    renderKeywordTab();
    scanTopics();
  }

  // ===== matching =====

  function normalizeText(value) {
    return String(value || '').toLocaleLowerCase();
  }

  function normalizeKeywords(keywords) {
    return [...new Set((keywords || []).map((k) => k.trim()).filter(Boolean))];
  }

  // 关键词小写形式缓存，仅在设置变更时重算
  let kwVersion = 0;
  let kwLower = [];

  function refreshKeywordCache() {
    // 与文本侧统一走 normalizeText，保证大小写归一化一致且对空值安全
    kwLower = settings.keywords.map((k) => normalizeText(k));
    kwVersion++;
  }

  // 匹配结果缓存：话题 id（或无 id 时的节点）→ 命中的关键词，设置变更后整批失效
  const matchCache = new Map();
  const nodeMatchCache = new WeakMap();

  // 按优先级逐个选择器取第一个非空文本。不能用逗号合并的 querySelector：
  // 它按文档序返回第一个匹配——置顶帖的「置顶」切换按钮（空文本的 a）在文档序上
  // 先于标题出现，会把标题顶掉，导致置顶帖永远无法按标题关键词过滤。
  function firstNonEmptyText(topic, selectorList) {
    for (const sel of selectorList.split(',')) {
      const t = topic.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  function getTopicText(topic) {
    const title = firstNonEmptyText(topic, TITLE_SELECTORS);
    const aria = topic.getAttribute('aria-label') || '';
    const category = topic.querySelector('.category-name')?.textContent || '';
    const tags = [...topic.querySelectorAll('.discourse-tag, .tag-wrapper')]
      .map((tag) => tag.textContent)
      .join(' ');
    const excerpt =
      topic.querySelector('.topic-excerpt, .excerpt')?.textContent || '';
    return normalizeText(
      [title, aria, category, tags, excerpt].join(' ').trim() ||
        topic.textContent,
    );
  }

  function findMatchedKeyword(topic, force) {
    if (kwLower.length === 0) return null;
    const id = topic.dataset.topicId;
    let entry = id ? matchCache.get(id) : nodeMatchCache.get(topic);
    if (!force && entry && entry.v === kwVersion) return entry.kw;

    const text = normalizeText(getTopicText(topic));
    let kw = null;
    for (let i = 0; i < kwLower.length; i++) {
      if (text.includes(kwLower[i])) {
        kw = settings.keywords[i];
        break;
      }
    }
    entry = { v: kwVersion, kw };
    if (id) matchCache.set(id, entry);
    else nodeMatchCache.set(topic, entry);
    return kw;
  }

  // 状态存 data 属性而非 class：Discourse(Ember) 异步补数据时会重写行的 class，
  // 注入的类会被抹掉导致帖子"闪回来"，data 属性则不受影响
  function applyTopicState(topic, matched) {
    const active = settings.enabled;
    const wantHidden = active && matched && settings.hideMode === 'hide';
    const wantDimmed = active && matched && settings.hideMode === 'dim';
    const state = wantHidden ? 'hidden' : wantDimmed ? 'dimmed' : null;
    if ((topic.dataset.lkcbState || null) === state) return;

    if (state) topic.dataset.lkcbState = state;
    else delete topic.dataset.lkcbState;
    if (matched && active) topic.dataset.lkcbMatch = matched;
    else topic.removeAttribute('data-lkcb-match');
  }

  // 嵌套命中的内层元素不应携带状态（插入竞态可能把状态打在内层上），清理残留
  function clearNestedState(topic) {
    topic
      .querySelectorAll?.('[data-lkcb-state],[data-lkcb-match]')
      .forEach((el) => {
        el.removeAttribute('data-lkcb-state');
        el.removeAttribute('data-lkcb-match');
      });
  }

  // 全量扫描：仅在初始化和设置变更时执行
  function scanTopics() {
    document.querySelectorAll(TOPIC_SELECTORS).forEach((topic) => {
      // 嵌套命中的内层元素不参与匹配，但要清理可能残留的状态
      if (topic.parentElement?.closest(TOPIC_SELECTORS)) {
        if (topic.dataset.lkcbState || topic.dataset.lkcbMatch) {
          delete topic.dataset.lkcbState;
          topic.removeAttribute('data-lkcb-match');
        }
        return;
      }
      applyTopicState(topic, findMatchedKeyword(topic));
    });
  }

  // ===== styles =====

  function injectStyles() {
    if (document.getElementById('lkcb-style')) return;
    const style = document.createElement('style');
    style.id = 'lkcb-style';
    // prettier-ignore
    style.textContent = `[data-lkcb-state="hidden"] { display: none !important; }
[data-lkcb-state="dimmed"] { opacity: 0.2 !important; }
[data-lkcb-state="dimmed"]:hover { opacity: 0.8 !important; }
#lkcb-menu-entry { width: 46px; height: 46px; padding: 6px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--primary, #222222); }
#lkcb-menu-entry:hover { color: var(--primary, #222222); }
#lkcb-menu-entry.active { color: var(--tertiary, #0088cc); }
#lkcb-menu-entry svg { pointer-events: none; }
#lkcb-quick-access { display: none; padding: 12px; font-size: 14px; color: var(--primary, #222222); }
.panel-body-contents[data-lkcb-view="keywords"] .quick-access-panel:not(#lkcb-quick-access) { display: none !important; }
.panel-body-contents[data-lkcb-view="keywords"] #lkcb-quick-access { display: flex; flex-direction: column; max-height: 100%; overflow: hidden; }
#lkcb-quick-access .lkcb-status { margin: 0 0 10px; font-size: 12px; color: var(--primary-medium, #919191); }
#lkcb-quick-access .lkcb-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#lkcb-quick-access .lkcb-row label { font-size: 13px; white-space: nowrap; cursor: pointer; }
#lkcb-quick-access .lkcb-grow { flex: 1; min-width: 0; }
#lkcb-quick-access input[type="text"] { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--secondary, #ffffff); color: var(--primary, #222222); }
#lkcb-quick-access input[type="text"]:focus { outline: 2px solid var(--tertiary, #0088cc); outline-offset: -1px; }
#lkcb-quick-access select { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--secondary, #ffffff); color: var(--primary, #222222); }
#lkcb-quick-access .lkcb-label { font-size: 12px; color: var(--primary-medium, #919191); white-space: nowrap; }
#lkcb-quick-access ul.lkcb-keywords { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: row; flex-wrap: wrap; gap: 6px; flex: 0 1 auto; min-height: 0; overflow-y: auto; }
#lkcb-quick-access ul.lkcb-keywords li { display: inline-flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; padding: 3px 10px; border: 1px solid var(--primary-low, #dddddd); border-radius: 9999px; background: var(--primary-very-low, #f8f8f8); font-size: 13px; }
#lkcb-quick-access ul.lkcb-keywords span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#lkcb-quick-access ul.lkcb-keywords button { flex-shrink: 0; border: none; background: none; padding: 0; color: var(--primary-medium, #919191); font-size: 14px; line-height: 1; cursor: pointer; }
#lkcb-quick-access ul.lkcb-keywords button:hover { color: var(--danger, #ff5555); }
#lkcb-quick-access .lkcb-empty { margin-bottom: 10px; padding: 14px; text-align: center; font-size: 13px; color: var(--primary-medium, #919191); border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; }
#lkcb-quick-access .lkcb-footer { display: flex; justify-content: flex-end; gap: 6px; }
/* 未登录时的独立悬浮面板：油猴菜单命令触发，页面平时不显示任何按钮 */
#lkcb-float { position: fixed; top: 72px; left: 50%; transform: translateX(-50%); z-index: 10000; width: 372px; max-width: calc(100vw - 20px); height: max-content; max-height: calc(100vh - 100px); border: 1px solid var(--primary-low, #dddddd); border-radius: 8px; background: var(--secondary, #ffffff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); overflow: hidden; display: flex; flex-direction: column; }
#lkcb-float #lkcb-quick-access { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
#lkcb-float-close { position: absolute; top: 6px; right: 6px; z-index: 1; width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%; background: var(--primary-low, #dddddd); color: var(--primary-medium, #919191); font-size: 14px; line-height: 1; cursor: pointer; }
#lkcb-float-close:hover { color: var(--primary, #222222); }`;
    document.documentElement.appendChild(style);
  }

  // ===== 头像菜单内的关键词管理视图 =====

  // 构建菜单内容区里的管理界面：容器复用原生 quick-access-panel 类，
  // 按钮复用 Discourse 的 btn/btn-primary/btn-default，颜色走主题变量，观感与原生一致
  function buildKeywordTab() {
    const container = document.createElement('div');
    container.id = 'lkcb-quick-access';
    container.className = 'quick-access-panel';
    // prettier-ignore
    container.innerHTML = `<p id="lkcb-status" class="lkcb-status">正在读取设置</p>
<div class="lkcb-row">
    <input id="lkcb-enabled" type="checkbox" />
    <label for="lkcb-enabled">启用屏蔽</label>
</div>
<div class="lkcb-row">
    <input id="lkcb-input" type="text" autocomplete="off" placeholder="输入关键词，逗号分隔" />
    <button id="lkcb-add" class="btn btn-primary" type="button">添加</button>
</div>
<div class="lkcb-row">
    <span class="lkcb-label">处理</span>
    <select id="lkcb-hideMode" class="lkcb-grow">
        <option value="hide">直接隐藏</option>
        <option value="dim">淡化显示</option>
    </select>
</div>
<ul id="lkcb-keywords" class="lkcb-keywords"></ul>
<div id="lkcb-empty" class="lkcb-empty" hidden>还没有关键词</div>
<div class="lkcb-footer">
    <button id="lkcb-export" class="btn btn-default" type="button">导出</button>
    <button id="lkcb-clear" class="btn btn-default" type="button">清空</button>
</div>`;
    // 视图在 Discourse 菜单内部：不拦截的话，点击会被菜单委托当成菜单项路由走
    //（实测点关键词的 × 会跳到个人资料页），键盘输入会触发全局快捷键。
    // 自身处理器绑定在子元素上，冒泡到容器时早已执行完毕，不受影响。
    container.addEventListener('click', (event) => event.stopPropagation());
    container.addEventListener('keydown', (event) => event.stopPropagation());
    bindKeywordTab(container);
    return container;
  }

  function bindKeywordTab(container) {
    const input = container.querySelector('#lkcb-input');
    const add = container.querySelector('#lkcb-add');
    const enabled = container.querySelector('#lkcb-enabled');
    const hideMode = container.querySelector('#lkcb-hideMode');
    const clear = container.querySelector('#lkcb-clear');
    const exportBtn = container.querySelector('#lkcb-export');

    add.addEventListener('click', async () => {
      const raw = input.value.trim();
      if (!raw) return;
      const newKeywords = raw
        .split(/[,，]/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (newKeywords.length === 0) return;
      await saveSettings({ keywords: [...settings.keywords, ...newKeywords] });
      input.value = '';
      input.focus();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        add.click();
      }
    });

    enabled.addEventListener('change', () => {
      saveSettings({ enabled: enabled.checked });
    });

    hideMode.addEventListener('change', () => {
      saveSettings({ hideMode: hideMode.value });
    });

    clear.addEventListener('click', () => {
      saveSettings({ keywords: [] });
    });

    exportBtn.addEventListener('click', () => {
      const blob = new Blob([settings.keywords.join(',')], {
        type: 'text/plain;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'linuxdo-keywords.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  // 渲染管理视图。target 缺省时渲染当前存在的所有实例（菜单视图和悬浮面板可能并存）
  function renderKeywordTab(target) {
    const containers = target
      ? [target]
      : [...document.querySelectorAll('#lkcb-quick-access')];
    for (const container of containers) {
      const status = container.querySelector('#lkcb-status');
      const enabled = container.querySelector('#lkcb-enabled');
      const hideMode = container.querySelector('#lkcb-hideMode');
      const list = container.querySelector('#lkcb-keywords');
      const empty = container.querySelector('#lkcb-empty');

      status.textContent = settings.enabled
        ? `已启用，${settings.keywords.length} 个关键词`
        : `已暂停，${settings.keywords.length} 个关键词`;
      enabled.checked = settings.enabled;
      hideMode.value = settings.hideMode;

      list.replaceChildren();
      empty.hidden = settings.keywords.length > 0;

      for (const keyword of settings.keywords) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        const remove = document.createElement('button');
        span.textContent = keyword;
        span.title = keyword;
        remove.textContent = '×';
        remove.title = `移除 ${keyword}`;
        remove.addEventListener('click', () => {
          saveSettings({
            keywords: settings.keywords.filter((k) => k !== keyword),
          });
        });
        li.append(span, remove);
        list.append(li);
      }
    }
  }

  // 「屏蔽词」标签激活：隐藏原生内容区（打在 panel-body-contents 的 data 属性上，
  // 与帖子行同理，Ember 重写 class 不影响），显示关键词管理视图
  function activateKeywordView() {
    keywordTabActive = true;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    // 只查本菜单内的视图实例：悬浮面板可能同时存在同 id 的另一份
    let view = contents.querySelector('#lkcb-quick-access');
    if (!view) {
      view = buildKeywordTab();
      contents.appendChild(view);
    }
    contents.dataset.lkcbView = 'keywords';
    // active 态与原生标签切换保持一致：自己点亮，其余熄灭
    contents.querySelectorAll('.user-menu-tab.active').forEach((tab) => {
      if (tab.id !== 'lkcb-menu-entry') tab.classList.remove('active');
    });
    document.getElementById('lkcb-menu-entry')?.classList.add('active');
    renderKeywordTab(view);
  }

  // 切回原生标签视图（点任意原生标签时调用）
  function deactivateKeywordView() {
    keywordTabActive = false;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    delete contents.dataset.lkcbView;
    document.getElementById('lkcb-menu-entry')?.classList.remove('active');
  }

  // Ember 可能异步重渲染菜单内容（如通知轮询），此时重建视图并恢复激活态
  function assertKeywordView(node) {
    if (!keywordTabActive) return;
    // 只关心菜单内部的变更
    if (!node.closest?.('.user-menu.menu-panel')) return;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    const view = contents.querySelector('#lkcb-quick-access');
    if (!view || !contents.dataset.lkcbView) {
      activateKeywordView();
    }
  }

  // ===== 未登录时的独立悬浮面板 =====

  let floatOutsideAbort = null;

  // 登录态走头像菜单；未登录时没有头像，油猴菜单命令直接弹出独立面板。
  // 页面平时不渲染任何按钮，只在命令触发时出现，避免挡住「登录」等原生元素。
  function openFloatPanel() {
    if (document.getElementById('lkcb-float')) return;
    const wrap = document.createElement('div');
    wrap.id = 'lkcb-float';
    const close = document.createElement('button');
    close.id = 'lkcb-float-close';
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', () => closeFloatPanel());
    wrap.appendChild(close);
    wrap.appendChild(buildKeywordTab());
    document.body.appendChild(wrap);
    renderKeywordTab(wrap.querySelector('#lkcb-quick-access'));

    // 点面板外任意处关闭（面板内部点击已被 buildKeywordTab 拦截冒泡，不会误关）
    floatOutsideAbort = new AbortController();
    document.addEventListener(
      'click',
      (event) => {
        if (!wrap.contains(event.target)) closeFloatPanel();
      },
      { signal: floatOutsideAbort.signal },
    );
  }

  function closeFloatPanel() {
    const wrap = document.getElementById('lkcb-float');
    if (!wrap) return;
    floatOutsideAbort?.abort();
    floatOutsideAbort = null;
    wrap.remove();
  }

  // ===== 头像菜单入口 =====

  // Discourse 每次打开头像菜单都会重新渲染整个面板（关闭即销毁），
  // 因此靠 MutationObserver 在面板出现时同步注入入口，销毁随面板走，无需清理
  function injectMenuEntry() {
    if (document.getElementById('lkcb-menu-entry')) return;
    // 标签按钮 id 全局唯一，直接定位插入点；不依赖面板选择器的文档顺序
    //（li#current-user 关闭时也带 user-menu-panel 类，querySelector 可能命中它）
    const profileTab = document.getElementById(PROFILE_TAB_ID);
    const tabsList =
      profileTab?.parentElement ||
      document.querySelector(MENU_TABS_FALLBACK_SELECTOR);
    if (!tabsList) return;

    const button = document.createElement('button');
    button.id = 'lkcb-menu-entry';
    // 复用 Discourse 标签按钮的类，外观与「个人资料」等保持一致
    button.className = 'btn btn-flat btn-icon no-text user-menu-tab';
    button.type = 'button';
    button.title = '屏蔽词';
    button.setAttribute('aria-label', '屏蔽词');
    // prettier-ignore
    button.innerHTML = `<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="M3 4h18l-7 8.5V20l-4 2.5v-10z"/></svg>`;
    button.addEventListener('click', (event) => {
      // 不让事件冒泡给 Discourse，避免被当成标签切换处理
      event.stopPropagation();
      activateKeywordView();
    });
    if (profileTab) profileTab.insertAdjacentElement('afterend', button);
    else tabsList.appendChild(button);
  }

  // 新增节点里出现用户菜单面板时立即注入（同步于绘制前，无闪烁）
  function watchForMenuPanel(node) {
    if (
      node.matches?.(USER_MENU_PANEL_SELECTOR) ||
      node.querySelector?.(USER_MENU_PANEL_SELECTOR)
    ) {
      injectMenuEntry();
    }
  }

  // ===== observer & init =====

  function startObserver() {
    // 原生标签分属 top-tabs / bottom-tabs 两组容器，且面板每次打开都重建，
    // 所以在 document 上挂一个捕获监听统一处理「点原生标签 → 切回原生视图」，
    // 不随面板销毁重建，也覆盖两组标签
    document.addEventListener(
      'click',
      (event) => {
        if (!keywordTabActive) return;
        const tab = event.target?.closest?.('.user-menu-tab');
        if (tab && tab.id !== 'lkcb-menu-entry') deactivateKeywordView();
      },
      true,
    );
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      // 菜单关闭时 Discourse 销毁整个面板；复位标签状态，
      // 保证重开菜单时回到原生默认视图（与原生行为一致）
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (
            node.matches?.(MENU_CLOSE_MARKERS) ||
            node.querySelector?.('#lkcb-menu-entry')
          ) {
            keywordTabActive = false;
          }
        }
      }
      handleAddedNodes(mutations);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // 新增行在浏览器绘制前同步处理，避免"先显示后隐藏"的闪现与跳动
  function handleAddedNodes(mutations) {
    const active = settings.enabled && settings.keywords.length > 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (typeof node.id === 'string' && node.id.startsWith('lkcb-'))
          continue;
        assertKeywordView(node);
        watchForMenuPanel(node);
        if (!active) {
          // 屏蔽关闭时，清掉 Ember 回收复用节点上可能残留的旧状态
          node.removeAttribute('data-lkcb-state');
          node.removeAttribute('data-lkcb-match');
          node
            .querySelectorAll?.('[data-lkcb-state],[data-lkcb-match]')
            .forEach((el) => {
              el.removeAttribute('data-lkcb-state');
              el.removeAttribute('data-lkcb-match');
            });
          continue;
        }
        if (node.matches(TOPIC_SELECTORS)) {
          // 未挂载的节点父链不完整，可能被误判为最外层行；等挂载时随子树统一处理
          if (
            node.isConnected &&
            !node.parentElement?.closest(TOPIC_SELECTORS)
          ) {
            applyTopicState(node, findMatchedKeyword(node));
            clearNestedState(node);
          }
          continue;
        }
        const descendants = node.querySelectorAll(TOPIC_SELECTORS);
        if (descendants.length === 0) {
          // 行内容通常是骨架先插入、文本后填充；带文本的节点才可能改变匹配结果
          if (!node.textContent || node.textContent.trim().length === 0)
            continue;
        }
        // 所属行内容已变化，强制重算（绕过按 topicId 的缓存）
        // 提升到最外层命中元素：搜索结果等场景下内层 [data-topic-id] 也符合选择器，
        // 直接用会把状态打在内层上
        let host = node.parentElement?.closest(TOPIC_SELECTORS);
        if (host) {
          let outer = host.parentElement?.closest(TOPIC_SELECTORS);
          while (outer) {
            host = outer;
            outer = host.parentElement?.closest(TOPIC_SELECTORS);
          }
          applyTopicState(host, findMatchedKeyword(host, true));
          clearNestedState(host);
        }
        for (const row of descendants) {
          if (row.parentElement?.closest(TOPIC_SELECTORS)) {
            clearNestedState(row);
            continue;
          }
          applyTopicState(row, findMatchedKeyword(row));
        }
      }
    }
  }

  async function init() {
    injectStyles();
    await loadSettings();
    injectMenuEntry();
    scanTopics();
    startObserver();

    try {
      GM.registerMenuCommand('打开 Linux.do 屏蔽词设置', () => {
        // 无论是否登录，菜单命令一律直接弹独立悬浮面板；
        // 登录用户另可走头像菜单里的「屏蔽词」标签
        openFloatPanel();
      });
    } catch (e) {
      // GM 菜单 API 不可用时跳过即可，主功能不受影响
    }
  }

  init();
})();
