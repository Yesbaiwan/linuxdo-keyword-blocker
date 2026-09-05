// ==UserScript==
// @name         Linux.do Keyword Blocker
// @namespace    https://linux.do/
// @version      1.3
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
    triggerPosition: null,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let panelOpen = false;

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

  const REFERENCE_BUTTON_SELECTOR = '.language-switcher-trigger';

  // ===== storage =====

  async function loadSettings() {
    const stored = await GM.getValue(STORAGE_KEY, null);
    const parsed = stored ? JSON.parse(stored) : {};
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
    renderPanel();
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
    kwLower = settings.keywords.map((k) => k.toLocaleLowerCase());
    kwVersion++;
  }

  // 匹配结果缓存：话题 id（或无 id 时的节点）→ 命中的关键词，设置变更后整批失效
  const matchCache = new Map();
  const nodeMatchCache = new WeakMap();

  function getTopicText(topic) {
    const title = topic.querySelector(TITLE_SELECTORS)?.textContent || '';
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
#lkcb-trigger { position: fixed; top: 10px; right: 20px; left: auto; bottom: auto; z-index: 99999; padding: 8px 12px; border: 1px solid #414350; border-radius: 4px; background: #373a47; color: #f2f2f2; cursor: move; font-family: system-ui, sans-serif; font-size: 14px; user-select: none; }
#lkcb-trigger:hover { background: #4a4e5e; }
#lkcb-trigger.dragging { cursor: grabbing; }
#lkcb-panel { position: fixed; z-index: 99999; width: 560px; max-width: 90vw; max-height: calc(100vh - 100px); overflow: auto; display: none; padding: 16px; border: 1px solid #414350; border-radius: 4px; background: #373a47; color: #f2f2f2; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.4; }
#lkcb-panel.open { display: block; }
#lkcb-panel * { color: #f2f2f2; }
#lkcb-panel h1 { margin: 0 0 4px; font-size: 16px; color: #fff; }
#lkcb-panel p { margin: 0; color: #a3a4aa; font-size: 12px; }
#lkcb-panel header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
#lkcb-panel .lkcb-header-actions { display: flex; align-items: center; gap: 10px; }
#lkcb-panel header label { font-size: 13px; white-space: nowrap; cursor: pointer; }
#lkcb-panel header input { margin-right: 4px; }
#lkcb-panel #lkcb-close { border: 1px solid #414350; border-radius: 4px; background: #2d303e; color: #a3a4aa; padding: 2px 8px; font-size: 18px; line-height: 1; cursor: pointer; }
#lkcb-panel #lkcb-close:hover { background: #414350; color: #f2f2f2; }
#lkcb-panel .lkcb-row { display: flex; gap: 8px; margin-bottom: 12px; }
#lkcb-panel .lkcb-row input { flex: 1; padding: 6px 8px; border: 1px solid #414350; border-radius: 4px; background: #2d303e; color: #f2f2f2; }
#lkcb-panel .lkcb-row button { padding: 6px 14px; border: 1px solid #bd93f9; border-radius: 4px; background: #bd93f9; color: #2d303e; cursor: pointer; }
#lkcb-panel .lkcb-row button:hover { background: #d1b3ff; border-color: #d1b3ff; }
#lkcb-panel .lkcb-field { margin-bottom: 12px; }
#lkcb-panel .lkcb-field label { display: block; margin-bottom: 4px; font-size: 12px; color: #a3a4aa; }
#lkcb-panel .lkcb-field select { padding: 6px 8px; border: 1px solid #414350; border-radius: 4px; background: #2d303e; color: #f2f2f2; }
#lkcb-panel .lkcb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
#lkcb-panel .lkcb-list li { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 10px; border: 1px solid #414350; border-radius: 9999px; background: #2d303e; }
#lkcb-panel .lkcb-list span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#lkcb-panel .lkcb-list button { border: none; background: none; color: #a3a4aa; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; flex-shrink: 0; }
#lkcb-panel .lkcb-list button:hover { color: #ff5555; }
#lkcb-panel .lkcb-empty { padding: 20px; text-align: center; color: #a3a4aa; font-size: 13px; border: 1px solid #414350; border-radius: 4px; background: #2d303e; }
#lkcb-panel .lkcb-footer { display: flex; justify-content: flex-end; margin-top: 12px; }
#lkcb-panel .lkcb-footer button { border: 1px solid #414350; border-radius: 4px; background: #2d303e; color: #f2f2f2; padding: 6px 14px; cursor: pointer; }
#lkcb-panel .lkcb-footer button:hover { background: #414350; }`;
    document.documentElement.appendChild(style);
  }

  // ===== panel =====

  function createPanel() {
    if (document.getElementById('lkcb-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'lkcb-panel';
    // prettier-ignore
    panel.innerHTML = `<header>
    <div>
        <h1>Linux.do 屏蔽词</h1>
        <p id="lkcb-status">正在读取设置</p>
    </div>
    <div class="lkcb-header-actions">
        <label><input id="lkcb-enabled" type="checkbox" /> 启用屏蔽</label>
        <button id="lkcb-close" type="button" title="关闭">×</button>
    </div>
</header>

<div class="lkcb-row">
    <input id="lkcb-input" type="text" autocomplete="off" placeholder="输入关键词，多个用逗号分隔" />
    <button id="lkcb-add" type="button">添加</button>
</div>

<div class="lkcb-field">
    <label>处理</label>
    <select id="lkcb-hideMode">
        <option value="hide">直接隐藏</option>
        <option value="dim">淡化显示</option>
    </select>
</div>

<div id="lkcb-empty" class="lkcb-empty">还没有关键词</div>
<ul id="lkcb-list" class="lkcb-list"></ul>

<div class="lkcb-footer">
    <button id="lkcb-export" type="button">导出</button>
    <button id="lkcb-reset-pos" type="button">还原位置</button>
    <button id="lkcb-clear" type="button">清空</button>
</div>
`;
    document.body.appendChild(panel);

    const trigger = document.createElement('button');
    trigger.id = 'lkcb-trigger';
    trigger.textContent = '屏蔽词';
    trigger.title = 'Linux.do 屏蔽词设置';
    trigger.addEventListener('click', () => {
      if (trigger.dataset.lkcbDragged === 'true') {
        trigger.dataset.lkcbDragged = 'false';
        return;
      }
      panelOpen = !panelOpen;
      if (panelOpen) positionPanel();
      panel.classList.toggle('open', panelOpen);
    });
    document.body.appendChild(trigger);

    if (settings.triggerPosition) {
      const { left, top } = settings.triggerPosition;
      trigger.style.left = `${Math.max(0, Math.min(window.innerWidth - (trigger.offsetWidth || 60), left))}px`;
      trigger.style.top = `${Math.max(0, Math.min(window.innerHeight - (trigger.offsetHeight || 30), top))}px`;
      trigger.style.right = 'auto';
      trigger.style.bottom = 'auto';
    }

    bindEvents();
  }

  function bindEvents() {
    const input = document.getElementById('lkcb-input');
    const add = document.getElementById('lkcb-add');
    const enabled = document.getElementById('lkcb-enabled');
    const hideMode = document.getElementById('lkcb-hideMode');
    const clear = document.getElementById('lkcb-clear');
    const exportBtn = document.getElementById('lkcb-export');
    const resetPos = document.getElementById('lkcb-reset-pos');
    const close = document.getElementById('lkcb-close');
    const trigger = document.getElementById('lkcb-trigger');

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

    resetPos.addEventListener('click', async () => {
      const trigger = document.getElementById('lkcb-trigger');
      if (trigger) delete trigger.dataset.lkcbPlaced;
      await saveSettings({ triggerPosition: null });
      positionTriggerDefault();
      if (panelOpen) positionPanel();
    });

    close.addEventListener('click', () => {
      panelOpen = false;
      document.getElementById('lkcb-panel').classList.remove('open');
    });

    document.addEventListener('click', (event) => {
      if (!panelOpen) return;
      const panel = document.getElementById('lkcb-panel');
      const path = event.composedPath();
      if (
        panel &&
        trigger &&
        !path.includes(panel) &&
        !path.includes(trigger)
      ) {
        panelOpen = false;
        panel.classList.remove('open');
      }
    });

    makeDraggable(trigger);
  }

  function positionPanel() {
    const trigger = document.getElementById('lkcb-trigger');
    const panel = document.getElementById('lkcb-panel');
    if (!trigger || !panel) return;

    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(560, window.innerWidth - 20);
    const minGap = 10;

    // 横向：哪边空间大就往哪边展开
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;

    if (spaceRight >= spaceLeft) {
      // 向右展开：面板左对齐按钮左侧
      let left = rect.left;
      if (left + panelWidth > window.innerWidth - minGap) {
        left = window.innerWidth - panelWidth - minGap;
      }
      left = Math.max(minGap, left);
      panel.style.left = left + 'px';
      panel.style.right = 'auto';
    } else {
      // 向左展开：面板右对齐按钮右侧
      let right = window.innerWidth - rect.right;
      if (right + panelWidth > window.innerWidth - minGap) {
        right = window.innerWidth - panelWidth - minGap;
      }
      right = Math.max(minGap, right);
      panel.style.right = right + 'px';
      panel.style.left = 'auto';
    }

    // 纵向：哪边空间大就往哪边展开
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    if (spaceBelow >= spaceAbove) {
      panel.style.top = rect.bottom + 8 + 'px';
      panel.style.bottom = 'auto';
    } else {
      panel.style.bottom = window.innerHeight - rect.top + 8 + 'px';
      panel.style.top = 'auto';
    }

    panel.style.width = panelWidth + 'px';
  }

  function positionTriggerDefault() {
    const trigger = document.getElementById('lkcb-trigger');
    if (!trigger || settings.triggerPosition || trigger.dataset.lkcbPlaced)
      return;

    const ref = document.querySelector(REFERENCE_BUTTON_SELECTOR);
    if (!ref) return;

    const rect = ref.getBoundingClientRect();
    trigger.style.top = '10px';
    trigger.style.right = `${window.innerWidth - rect.left + 20}px`;
    trigger.style.left = 'auto';
    trigger.style.bottom = 'auto';
    trigger.dataset.lkcbPlaced = 'true';
  }

  function makeDraggable(el) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (el.dataset.lkcbDragged === 'true') {
        settings.triggerPosition = {
          left: parseInt(el.style.left, 10) || 0,
          top: parseInt(el.style.top, 10) || 0,
        };
        GM.setValue(STORAGE_KEY, JSON.stringify(settings));
      }
    }

    el.addEventListener('mousedown', (e) => {
      dragging = true;
      el.dataset.lkcbDragged = 'false';
      el.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      el.style.left = startLeft + 'px';
      el.style.top = startTop + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.dataset.lkcbDragged = 'true';
      el.style.left =
        Math.max(
          0,
          Math.min(
            window.innerWidth - el.offsetWidth,
            startLeft + e.clientX - startX,
          ),
        ) + 'px';
      el.style.top =
        Math.max(
          0,
          Math.min(
            window.innerHeight - el.offsetHeight,
            startTop + e.clientY - startY,
          ),
        ) + 'px';
      if (panelOpen) positionPanel();
    });

    document.addEventListener('mouseup', endDrag);
    document.addEventListener('mouseleave', endDrag);
    window.addEventListener('blur', endDrag);
  }

  function renderPanel() {
    const status = document.getElementById('lkcb-status');
    const enabled = document.getElementById('lkcb-enabled');
    const hideMode = document.getElementById('lkcb-hideMode');
    const list = document.getElementById('lkcb-list');
    const empty = document.getElementById('lkcb-empty');

    if (!status) return;

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

  // ===== observer & init =====

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (!settings.triggerPosition) positionTriggerDefault();
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
    createPanel();
    renderPanel();
    positionTriggerDefault();
    scanTopics();
    startObserver();

    window.addEventListener('resize', () => {
      positionTriggerDefault();
      if (panelOpen) positionPanel();
    });

    try {
      GM.registerMenuCommand('打开 Linux.do 屏蔽词设置', () => {
        const panel = document.getElementById('lkcb-panel');
        if (panel) {
          panelOpen = true;
          panel.classList.add('open');
        }
      });
    } catch (e) {
      // optional
    }
  }

  init();
})();
