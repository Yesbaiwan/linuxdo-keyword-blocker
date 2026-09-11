// ==UserScript==
// @name         Linux.do Keyword Blocker
// @namespace    https://linux.do/
// @version      2.5.0
// @description  用「类别/标签/标题」规则屏蔽 linux.do 上不想看到的帖子（需登录使用）
// @author       linuxdo-keyword-blocker
// @match        https://linux.do/*
// @homepageURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker
// @downloadURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @updateURL    https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 幂等守卫：同文档重复注入会产生双实例互踩渲染
  if (window.__lkcbLoaded) return;
  window.__lkcbLoaded = true;

  const STORAGE_KEY = 'linuxdo-keyword-blocker-settings';
  const CATEGORY_CACHE_KEY = 'linuxdo-keyword-blocker-categories';
  const CATEGORY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 站点类别树体积大，缓存 7 天
  const MAX_TAGS = 3; // 单条规则的标签上限（每框一个，点「+」增设）
  // 规则 { category, allLevels, tags, noTag, title, enabled }：已填字段全部命中才命中（AND），
  // 至少填一项；allLevels 命中自身+全部等级后代，noTag 匹配零标签帖（与 tags 互斥）
  const DEFAULT_SETTINGS = { enabled: true, rules: [], hideMode: 'dim' };

  // 列表页行与搜索结果行；搜索结果里内层也带 topic-id，统一按最外层行处理
  const TOPIC_SELECTORS =
    '.fps-result, .latest-topic-list-item, .topic-list-item, [data-topic-id]';
  // 标题取第一个非空文本；不能用逗号合并的 querySelector（置顶帖的空文本按钮在文档序上先于标题）
  const TITLE_SELECTORS = ['.title', '.topic-title', "a[href^='/t/']"];

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let editingIndex = -1; // 正在展开编辑表单的规则下标（-1 = 无）
  let editForm = null;
  let addForm = null;
  let activePicker = null; // 当前展开的类别下拉浮层，供面板滚动/窗口缩放时重新定位
  let statusTimer = null;
  let ready = false; // 类别树就绪前不落状态，否则同一行会被算两遍、页面上跳两次
  let catTreeFailed = false; // 类别列表没拉到：面板里明确提示，别静默降级

  // ===== 类别树 =====

  const catById = new Map(); // id → { id, name, parent }
  const catChildren = new Map(); // 父 id → 子 id[]
  const catOrder = []; // 顶级分类 id，按展示顺序

  function buildCategoryIndex(cats) {
    catById.clear();
    catChildren.clear();
    catOrder.length = 0;
    for (const c of cats)
      catById.set(c.id, {
        id: c.id,
        name: c.name,
        parent: c.parent == null ? null : Number(c.parent),
      });
    for (const c of catById.values()) {
      // 父分类不在可见列表（受限或已删除）时按顶级展示，保证不丢项
      if (c.parent == null || !catById.has(c.parent)) {
        c.parent = null;
        catOrder.push(c.id);
      } else {
        const arr = catChildren.get(c.parent) || [];
        arr.push(c.id);
        catChildren.set(c.parent, arr);
      }
    }
  }

  // 下拉与规则行共用的展示名：有子分类的分类标注「（不带等级）」，避免被当成整个大类
  function categoryName(id, allLevels) {
    const cat = catById.get(id);
    if (!cat) return String(id);
    if (allLevels) return `${cat.name}（所有等级）`;
    return catChildren.get(id)?.length ? `${cat.name}（不带等级）` : cat.name;
  }

  // 一个分类在列表里的条目：有子分类的给「所有等级」+「不带等级」两条，没有的只给裸名字
  function categoryOptions(id) {
    return catChildren.get(id)?.length
      ? [
          [categoryName(id, true), true],
          [categoryName(id), false],
        ]
      : [[categoryName(id), false]];
  }

  // 类别框与标题框的宽度按最长选项撑开（含子分类缩进），不撑满整行：两者都是短文本
  function syncFieldWidth() {
    const panel = document.getElementById('lkcb-panel');
    if (!panel || catById.size === 0) return;
    const style = getComputedStyle(panel);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    let widest = 0;
    const walk = (id, depth) => {
      for (const [name] of categoryOptions(id))
        widest = Math.max(
          widest,
          ctx.measureText(name).width + 10 + depth * 16,
        );
      for (const childId of catChildren.get(id) || []) walk(childId, depth + 1);
    };
    for (const topId of catOrder) walk(topId, 0);
    // 余量：输入框内边距 16 + 清除键与箭头 ≈24 + 边框留白
    panel.style.setProperty('--lkcb-field-w', `${Math.ceil(widest) + 48}px`);
  }

  // 缓存优先（7 天）拉站点类别树；拉不到重试 3 次，仍失败就标记出来，在面板里提示并给重试入口
  async function loadCategoryTree() {
    catTreeFailed = false;
    const cached = await GM.getValue(CATEGORY_CACHE_KEY, null);
    if (cached) {
      try {
        const { ts, categories } = JSON.parse(cached);
        if (Date.now() - ts < CATEGORY_CACHE_TTL)
          buildCategoryIndex(categories);
      } catch {
        /* 缓存损坏当作没有 */
      }
    }
    if (catById.size === 0) {
      for (let attempt = 1; attempt <= 3 && catById.size === 0; attempt++) {
        try {
          const res = await fetch('/site.json', {
            headers: { Accept: 'application/json' },
          });
          if (!res.ok) throw new Error('site.json ' + res.status);
          const data = await res.json();
          buildCategoryIndex(
            (data.categories || []).map((c) => ({
              id: c.id,
              name: c.name,
              parent: c.parent_category_id ?? null,
            })),
          );
          GM.setValue(
            CATEGORY_CACHE_KEY,
            JSON.stringify({
              ts: Date.now(),
              categories: [...catById.values()],
            }),
          ).catch(() => {});
        } catch {
          if (attempt < 3)
            await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      catTreeFailed = catById.size === 0;
    }
    bumpMatchVersion();
    editingIndex = -1;
    syncFieldWidth();
    renderRules();
  }

  // ===== 存储 =====

  async function loadSettings() {
    let parsed = {};
    try {
      parsed = JSON.parse(await GM.getValue(STORAGE_KEY, '{}')) || {};
    } catch {
      /* 存储损坏时回退默认设置 */
    }
    settings = {
      enabled: parsed.enabled !== false,
      hideMode: parsed.hideMode === 'hide' ? 'hide' : 'dim',
      rules: normalizeRules(parsed.rules),
    };
    bumpMatchVersion();
  }

  // 设置变更统一入口：写存储、重算匹配缓存、重扫页面；rebuild 时重建列表（先复位编辑态）
  async function updateSettings(patch, rebuild) {
    if (rebuild) {
      editingIndex = -1;
      editForm = null;
    }
    settings = { ...settings, ...patch };
    settings.rules = normalizeRules(settings.rules);
    bumpMatchVersion();
    if (rebuild) renderRules();
    else renderStatus();
    scanTopics();
    await GM.setValue(STORAGE_KEY, JSON.stringify(settings));
  }

  // ===== 匹配 =====

  function normalizeText(value) {
    return String(value || '').toLocaleLowerCase();
  }

  // 每框一个标签（不切分逗号），去空并按上限截断
  function normalizeTags(list) {
    return list
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  }
  // 规则至少填一项，全空视为无效
  function isEmptyRule(rule) {
    return (
      rule.category == null &&
      rule.tags.length === 0 &&
      !rule.noTag &&
      !rule.title
    );
  }

  function normalizeRules(rules) {
    const seen = new Set();
    const out = [];
    for (const raw of rules || []) {
      const parsed = parseInt(raw?.category, 10);
      const category = Number.isNaN(parsed) ? null : parsed;
      // 「无标签」与标签列表互斥，勾选 noTag 后不保留 tags
      const noTag = !!raw?.noTag;
      const rule = {
        category,
        // 不限等级只在选到类别时有意义（命中该分类自身 + 全部后代等级）
        allLevels: category != null && !!raw?.allLevels,
        tags: noTag ? [] : normalizeTags(raw?.tags || []),
        noTag,
        title: String(raw?.title || '').trim(),
        enabled: raw?.enabled !== false,
      };
      if (isEmptyRule(rule)) continue;
      const key = `${rule.category}|${rule.allLevels}|${rule.tags}|${rule.noTag}|${rule.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rule);
    }
    return out;
  }

  function ruleLabel(rule) {
    const parts = [];
    if (rule.category != null)
      parts.push('类别:' + categoryName(rule.category, rule.allLevels));
    if (rule.noTag) parts.push('无标签');
    else if (rule.tags.length) parts.push('标签:' + rule.tags.join('、'));
    if (rule.title) parts.push('标题:' + rule.title);
    return parts.join(' + ');
  }

  // 匹配规则缓存：类别存徽章 ID 集合，默认仅所选分类自身，「所有等级」扩展为自身+全部后代等级
  let matchVersion = 0;
  let ruleCache = [];

  function collectLevelIds(id) {
    const ids = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (ids.has(cur)) continue;
      ids.add(cur);
      stack.push(...(catChildren.get(cur) || []));
    }
    return ids;
  }

  function bumpMatchVersion() {
    // 停用的规则不参与匹配：需总开关与规则自身开关同时打开
    ruleCache = settings.rules
      .filter((rule) => rule.enabled !== false)
      .map((rule) => ({
        label: ruleLabel(rule),
        categoryIds:
          rule.category == null
            ? null
            : (rule.allLevels
                ? [...collectLevelIds(rule.category)]
                : [rule.category]
              ).map(String),
        tags: rule.tags.map(normalizeText),
        noTag: rule.noTag,
        title: normalizeText(rule.title),
      }));
    matchVersion++;
  }

  // 匹配结果缓存：话题 id（无 id 时按节点）→ 命中规则的展示文本，设置变更后整批失效
  const matchCache = new Map();
  const nodeMatchCache = new WeakMap();

  // 标题取第一个非空文本并归一化（匹配一律大小写不敏感）
  function topicTitle(topic) {
    for (const sel of TITLE_SELECTORS) {
      const text = topic.querySelector(sel)?.textContent.trim();
      if (text) return normalizeText(text);
    }
    return '';
  }

  // 类别只认徽章上的 data-category-id；子分类页面行内无徽章，类别规则天然不命中
  function getTopicCategoryIds(topic) {
    return new Set(
      [...topic.querySelectorAll('span.badge-category[data-category-id]')]
        .map((el) => el.getAttribute('data-category-id'))
        .filter(Boolean),
    );
  }

  function getTopicTags(topic) {
    return [...topic.querySelectorAll('a.discourse-tag')]
      .map((el) => normalizeText(el.textContent.trim()))
      .filter(Boolean);
  }

  // 已填字段必须全部命中：类别按徽章 ID 集合比对，标签全命中或要求零标签，标题包含匹配
  function matchRule(title, catIds, tags) {
    for (const cached of ruleCache) {
      const cats = cached.categoryIds;
      if (cats && ![...catIds].some((x) => cats.includes(x))) continue;
      if (cached.noTag) {
        if (tags.length) continue;
      } else if (
        cached.tags.length &&
        !cached.tags.every((t) => tags.includes(t))
      ) {
        continue;
      }
      if (cached.title && !title.includes(cached.title)) continue;
      return cached.label;
    }
    return null;
  }

  // 缓存带内容指纹：标题/类别/标签任一变化就重算；骨架期算出的「不命中」也安全（内容填进来
  // 指纹必然改变），未命中同样缓存，不必每次重算
  function findMatchedRule(topic) {
    if (ruleCache.length === 0) return null;
    const title = topicTitle(topic);
    const catIds = getTopicCategoryIds(topic);
    const tags = getTopicTags(topic);
    const id = topic.dataset.topicId;
    const sig = `${title}\u0001${[...catIds].sort().join(',')}\u0001${tags.join(',')}`;
    const entry = id ? matchCache.get(id) : nodeMatchCache.get(topic);
    if (entry && entry.v === matchVersion && entry.sig === sig)
      return entry.rule;
    const rule = matchRule(title, catIds, tags);
    const hit = { v: matchVersion, sig, rule };
    if (!id) nodeMatchCache.set(topic, hit);
    else {
      // 上限保护：长时间浏览会按 topicId 累积，超过阈值整批丢弃（重算很便宜）
      if (matchCache.size >= 4000) matchCache.clear();
      matchCache.set(id, hit);
    }
    return rule;
  }

  // 状态存 data 属性而非 class：Ember 异步补数据会重写行的 class，注入的类会被抹掉。
  // 值必须是 CSS 里的 hidden/dimmed，不能直接用 hideMode
  function applyTopicState(topic, matched) {
    const hit = settings.enabled ? matched : null;
    const hide = settings.hideMode === 'hide';
    const state = hit ? (hide ? 'hidden' : 'dimmed') : null;
    if ((topic.dataset.lkcbState || null) === state) return;
    if (state) topic.dataset.lkcbState = state;
    else delete topic.dataset.lkcbState;
  }

  // 嵌套命中的内层元素不应携带状态（插入竞态可能把状态打在内层上），清理残留
  function clearNestedState(topic) {
    topic
      .querySelectorAll('[data-lkcb-state]')
      .forEach((el) => el.removeAttribute('data-lkcb-state'));
  }

  // 全量扫描：仅在初始化和设置变更时执行
  function scanTopics() {
    for (const topic of document.querySelectorAll(TOPIC_SELECTORS)) {
      if (topic.parentElement?.closest(TOPIC_SELECTORS)) staleClean(topic);
      else applyTopicState(topic, findMatchedRule(topic));
    }
  }

  // ===== 样式 =====

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'lkcb-style';
    // prettier-ignore
    style.textContent = `/* 行状态 */ [data-lkcb-state="hidden"] { display: none !important; } [data-lkcb-state="dimmed"] { opacity: 0.2 !important; } [data-lkcb-state="dimmed"]:hover { opacity: 0.8 !important; }
/* 遮罩与面板 */ #lkcb-overlay { position: fixed; inset: 0; z-index: 2147483000; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.45); } #lkcb-overlay.lkcb-open { display: flex; }
#lkcb-panel { --lkcb-field-w: 210px; display: flex; flex-direction: column; width: 540px; max-height: 100%; overflow: hidden; background: var(--secondary, #ffffff); color: var(--primary, #222222); border: 1px solid var(--primary-low, #dddddd); border-radius: 10px; box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35); font-size: 14px; } #lkcb-panel [hidden] { display: none !important; }
/* 站点给 input/checkbox 的隐含外边距会把控件挤歪：面板内一律归零并统一高度 */
#lkcb-panel input, #lkcb-panel select, #lkcb-panel button, #lkcb-panel label, #lkcb-panel ul, #lkcb-panel li { margin: 0; box-sizing: border-box; }
#lkcb-panel input[type="text"], #lkcb-panel select { height: 32px; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--secondary, #ffffff); color: var(--primary, #222222); } #lkcb-panel input[type="text"] { flex: 1; min-width: 0; } #lkcb-panel select { flex: none; width: fit-content; } #lkcb-panel input.lkcb-title { flex: 0 0 var(--lkcb-field-w); } #lkcb-panel input[type="text"]:focus { outline: 2px solid var(--tertiary, #0088cc); outline-offset: -1px; }
/* 骨架 */ #lkcb-panel .lkcb-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--primary-low, #dddddd); flex-shrink: 0; } #lkcb-panel .lkcb-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; } #lkcb-panel .lkcb-footer { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 16px; border-top: 1px solid var(--primary-low, #dddddd); flex-shrink: 0; }
#lkcb-panel .lkcb-head { font-size: 15px; font-weight: 700; } #lkcb-panel .lkcb-status { flex: 1; min-width: 0; font-size: 12px; color: var(--primary-medium, #919191); text-align: right; }
/* 字段行 */ #lkcb-panel .lkcb-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; } #lkcb-panel .lkcb-row label { font-size: 13px; white-space: nowrap; cursor: pointer; } #lkcb-panel .lkcb-label { flex-shrink: 0; font-size: 13px; color: var(--primary-medium, #919191); } #lkcb-panel .lkcb-actions { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }
/* 无边框图标按钮：关闭 / 类别清除 / 类别箭头 / 标签 × */ #lkcb-panel #lkcb-close, #lkcb-panel .lkcb-cat-clear, #lkcb-panel .lkcb-cat-caret, #lkcb-panel .lkcb-tag-remove { flex-shrink: 0; border: none; background: none; padding: 0; line-height: 1; color: var(--primary-medium, #919191); cursor: pointer; }
#lkcb-panel #lkcb-close { padding: 2px 8px; font-size: 18px; } #lkcb-panel .lkcb-cat-clear { font-size: 14px; } #lkcb-panel .lkcb-cat-caret { font-size: 10px; }
#lkcb-panel #lkcb-close:hover, #lkcb-panel .lkcb-cat-clear:hover, #lkcb-panel .lkcb-tag-remove:hover { color: var(--danger, #ff5555); } #lkcb-panel .lkcb-cat-caret:hover { color: var(--primary, #222222); }
/* 类别下拉：候选列表是 fixed 浮层，不参与面板布局 */ #lkcb-panel .lkcb-cat-picker { flex: 0 0 var(--lkcb-field-w); min-width: 0; } #lkcb-panel .lkcb-cat-input-row { display: flex; align-items: center; gap: 2px; } #lkcb-panel .lkcb-cat-input-row .lkcb-cat-input { flex: 1; min-width: 0; }
#lkcb-panel .lkcb-cat-list { position: fixed; box-sizing: border-box; z-index: 5; max-height: 220px; overflow-y: auto; background: var(--secondary, #ffffff); border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); }
#lkcb-panel .lkcb-cat-item { padding: 7px 10px; font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } #lkcb-panel .lkcb-cat-item:hover { background: var(--primary-very-low, #f8f8f8); } #lkcb-panel .lkcb-cat-none { color: var(--primary-medium, #919191); } #lkcb-panel .lkcb-cat-item[data-retry] { color: var(--danger, #ff5555); }
/* 标签组：框 + 框内右侧 × + 添加按钮 + 「无标签」 */ #lkcb-panel .lkcb-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; } #lkcb-panel .lkcb-tag-box { position: relative; display: flex; align-items: center; flex: 0 1 108px; min-width: 0; } #lkcb-panel .lkcb-tag-box input[type="text"] { flex: 1; min-width: 0; padding-right: 22px; }
#lkcb-panel .lkcb-tag-remove { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; font-size: 14px; }
#lkcb-panel .lkcb-tag-add { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px dashed var(--primary-low, #dddddd); border-radius: 4px; background: none; color: var(--primary-medium, #919191); font-size: 16px; line-height: 1; cursor: pointer; } #lkcb-panel .lkcb-tag-add:hover { color: var(--tertiary, #0088cc); border-color: var(--tertiary, #0088cc); }
#lkcb-panel .lkcb-notag-label { display: flex; align-items: center; gap: 4px; flex-shrink: 0; white-space: nowrap; font-size: 13px; cursor: pointer; }
/* 规则列表 */ #lkcb-panel ul.lkcb-rules { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; } #lkcb-panel ul.lkcb-rules li { padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--primary-very-low, #f8f8f8); font-size: 13px; } #lkcb-panel ul.lkcb-rules li.lkcb-editing { border-color: var(--tertiary, #0088cc); }
#lkcb-panel .lkcb-rule-line { display: flex; align-items: center; gap: 6px; } #lkcb-panel .lkcb-rule-line input[type="checkbox"] { flex-shrink: 0; } #lkcb-panel .lkcb-rule-text { flex: 1; min-width: 0; line-height: 1.5; word-break: break-word; } #lkcb-panel li.lkcb-off .lkcb-rule-text { opacity: 0.45; text-decoration: line-through; }
#lkcb-panel .lkcb-rule-line button { flex-shrink: 0; display: flex; align-items: center; justify-content: center; height: 20px; border: none; background: none; padding: 0; color: var(--primary-medium, #919191); font-size: 12px; line-height: 1; cursor: pointer; } #lkcb-panel .lkcb-rule-line button.lkcb-edit:hover { color: var(--tertiary, #0088cc); } #lkcb-panel .lkcb-rule-line button.lkcb-remove { width: 18px; font-size: 14px; } #lkcb-panel .lkcb-rule-line button.lkcb-remove:hover { color: var(--danger, #ff5555); }
#lkcb-panel .lkcb-rule-edit { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--primary-low, #dddddd); } #lkcb-panel .lkcb-rule-edit .lkcb-row { margin-bottom: 8px; } #lkcb-panel .lkcb-rule-edit .lkcb-row:last-child { margin-bottom: 0; }
#lkcb-panel .lkcb-empty { margin-top: 10px; padding: 14px; text-align: center; font-size: 13px; color: var(--primary-medium, #919191); border: 1px dashed var(--primary-low, #dddddd); border-radius: 4px; }`;
    document.documentElement.appendChild(style);
  }

  // ===== 规则表单（添加与行内编辑共用） =====

  function fieldRow(labelText) {
    const row = document.createElement('div');
    row.className = 'lkcb-row';
    row.innerHTML = `<span class="lkcb-label">${labelText}</span>`; // 调用方只传固定文案
    return row;
  }

  // 类别下拉 + 标签组 + 标题 + 无标签，添加与行内编辑共用同一套字段与排版，
  // 差异只在调用方挂进 actions 的按钮
  function createRuleForm(initial, onSubmit) {
    const picker = createCategoryPicker(initial);
    const tagsRow = fieldRow('标签');
    const tags = createTagInputs(initial?.tags || [], tagsRow);
    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'lkcb-title';
    title.autocomplete = 'off';
    title.placeholder = '包含即命中';
    title.value = initial?.title || '';
    const noTag = document.createElement('input');
    noTag.type = 'checkbox';
    noTag.className = 'lkcb-notag';
    noTag.checked = !!initial?.noTag;
    tagsRow.insertAdjacentHTML(
      'beforeend',
      '<label class="lkcb-notag-label" title="只匹配不带任何标签的帖子；勾选后标签框全部收起，标签条件即「零标签」，可与类别、标题叠加">无标签</label>',
    );
    tagsRow.querySelector('.lkcb-notag-label').prepend(noTag);
    // 勾选「无标签」= 标签条件换成「零标签」，标签框此时无意义，整组收起
    const syncNoTag = () => tags.setBoxesHidden(noTag.checked);
    noTag.addEventListener('change', syncNoTag);
    syncNoTag();

    const catRow = fieldRow('类别');
    catRow.append(picker.root);
    const titleRow = fieldRow('标题');
    titleRow.append(title);
    const actions = document.createElement('span');
    actions.className = 'lkcb-actions';
    const actionsRow = document.createElement('div');
    actionsRow.className = 'lkcb-row';
    actionsRow.append(actions);
    const root = document.createElement('div');
    root.append(catRow, tagsRow, titleRow, actionsRow);

    // Enter 提交：只挂在标签组与标题上，避免与类别下拉的回车选中冲突
    for (const el of [tags.root, title])
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        onSubmit();
      });

    return {
      root,
      actions,
      title,
      read: () => ({
        category: picker.value.category,
        allLevels: picker.value.allLevels,
        tags: noTag.checked ? [] : tags.values,
        noTag: noTag.checked,
        title: title.value.trim(),
      }),
      reset() {
        picker.reset();
        tags.reset();
        tags.setBoxesHidden(false);
        noTag.checked = false;
        title.value = '';
      },
    };
  }

  // 类别下拉：外观与普通下拉框一致（右侧箭头点击开合），但保留输入即过滤——
  // 站点分类含各等级共 80+ 项，纯 select 翻找太累。搜索词是临时的，失焦未选择则
  // 恢复原值，只有显式点选或点 × 清除才改变选中结果。
  // 列表用 fixed 浮层挂在下拉框上下方，不参与面板布局（展开不撑高面板、不挤压表单）
  function createCategoryPicker(initial) {
    const root = document.createElement('div');
    root.className = 'lkcb-cat-picker';
    // prettier-ignore
    root.innerHTML = `<div class="lkcb-cat-input-row"><input class="lkcb-cat-input" type="text" autocomplete="off" title="点击展开列表，可直接输入筛选" />
<button type="button" class="lkcb-cat-clear" title="清除已选类别" hidden>×</button>
<button type="button" class="lkcb-cat-caret" title="展开类别列表" aria-label="展开类别列表">▼</button></div>
<div class="lkcb-cat-list" hidden></div>`;
    const input = root.querySelector('input');
    const clearBtn = root.querySelector('.lkcb-cat-clear');
    const caret = root.querySelector('.lkcb-cat-caret');
    const list = root.querySelector('.lkcb-cat-list');
    // 选中值 { category, allLevels }：category 为分类自身徽章 ID，allLevels 表示
    // 「所有等级」（自身+全部后代），仅对有子分类的父类提供
    let selected =
      initial?.category == null
        ? { category: null, allLevels: false }
        : {
            category: Number(initial.category),
            allLevels: !!initial.allLevels,
          };
    let searching = false; // 正在输入搜索词（尚未确认选择）

    const isOpen = () => !list.hidden;
    // 把浮层贴到输入框下方；下方空间不够且上方更宽裕时改为向上弹
    function reposition() {
      if (list.hidden) return;
      const rect = input.getBoundingClientRect();
      const gap = 4;
      const below = window.innerHeight - rect.bottom - gap;
      const above = rect.top - gap;
      const openUp = below < 160 && above > below;
      list.style.width = `${rect.width}px`;
      list.style.left = `${Math.max(4, rect.left)}px`;
      list.style.top = openUp ? 'auto' : `${rect.bottom + gap}px`;
      list.style.bottom = openUp
        ? `${window.innerHeight - rect.top + gap}px`
        : 'auto';
      list.style.maxHeight = `${Math.max(90, Math.min(220, openUp ? above : below))}px`;
    }
    function syncInput() {
      input.value =
        selected.category == null
          ? ''
          : categoryName(selected.category, selected.allLevels);
      clearBtn.hidden = selected.category == null;
    }
    function openList() {
      renderCategoryOptions(list, searching ? input.value : '');
      list.hidden = false;
      reposition();
      activePicker = api;
    }
    function closeList() {
      list.hidden = true;
      if (activePicker === api) activePicker = null;
      searching = false;
      syncInput();
    }
    function choose(id, allLevels) {
      selected =
        id == null || id === ''
          ? { category: null, allLevels: false }
          : { category: Number(id), allLevels: !!allLevels };
      closeList(); // 复位搜索态并回填输入框
    }
    // 取要选中的项：item 为点击目标，缺省取第一个真实类别（回车确认）
    const pick = (item) => {
      const el =
        item || list.querySelector('.lkcb-cat-item[data-id]:not([data-id=""])');
      if (el) choose(el.dataset.id, el.dataset.allLevels === '1');
    };

    input.addEventListener('focus', () => {
      input.select();
      openList();
    });
    input.addEventListener('input', () => {
      searching = true;
      openList();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 只收起下拉，不冒泡给面板级 Esc（避免误关整个面板）
        e.stopPropagation();
        closeList();
      } else if (e.key === 'Enter' && isOpen()) {
        e.preventDefault();
        pick(null);
      }
    });
    input.addEventListener('blur', closeList);
    // 阻止 mousedown 默认行为，避免点选项前输入框先失焦把下拉收起
    for (const el of [list, clearBtn, caret])
      el.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.lkcb-cat-item');
      if (!item) return;
      if (item.dataset.retry) {
        // 拉取失败时下拉里给的补救入口：重新拉一次，再刷新候选
        loadCategoryTree().then(openList);
        return;
      }
      pick(item);
    });
    clearBtn.addEventListener('click', () => choose(null, false));
    // 箭头与普通下拉的三角一致：点一下开、再点一下收
    caret.addEventListener('click', () => {
      if (isOpen()) closeList();
      else {
        input.focus();
        openList();
      }
    });

    syncInput();
    const api = {
      root,
      reposition,
      get value() {
        return { ...selected };
      },
      reset: () => choose(null, false),
    };
    return api;
  }

  // 缩进树形渲染类别下拉，按 query 过滤；父类额外给一条「（所有等级）」
  function renderCategoryOptions(list, query) {
    const q = normalizeText(query).trim();
    const frag = document.createDocumentFragment();
    const push = (id, name, depth, allLevels, retry) => {
      if (q && !normalizeText(name).includes(q)) return;
      const item = document.createElement('div');
      item.className =
        id === '' ? 'lkcb-cat-item lkcb-cat-none' : 'lkcb-cat-item';
      if (allLevels) item.dataset.allLevels = '1';
      if (retry) item.dataset.retry = '1';
      item.dataset.id = id;
      item.style.paddingLeft = `${10 + depth * 16}px`;
      item.textContent = name;
      frag.append(item);
    };
    // 有等级子分类的：先「所有等级」再「不带等级」，之后逐个等级；没有子分类的直接给裸名字
    const walk = (id, depth) => {
      for (const [name, allLevels] of categoryOptions(id))
        push(id, name, depth, allLevels);
      for (const childId of catChildren.get(id) || []) walk(childId, depth + 1);
    };
    push('', '不按类别筛选', 0, false);
    for (const topId of catOrder) walk(topId, 0);
    if (!catById.size)
      push(
        '',
        catTreeFailed ? '类别列表没拉到，点此重试' : '类别列表不可用',
        0,
        false,
        catTreeFailed,
      );
    else if (frag.childElementCount === 1) push('', '没有匹配的类别', 0, false);
    list.replaceChildren(frag);
  }

  // 标签输入组：默认 1 个框，点「+」增设至多 MAX_TAGS 个，每个框可 × 移除
  //（只剩 1 个框时不给 ×，避免整组被清空）。container 是所在行，整组随该行收起
  function createTagInputs(initialTags, container) {
    container.classList.add('lkcb-tags');
    container.insertAdjacentHTML(
      'beforeend',
      `<button type="button" class="lkcb-tag-add" title="添加标签（最多 ${MAX_TAGS} 个）">+</button>`,
    );
    const add = container.querySelector('.lkcb-tag-add');
    const boxes = () => [...container.querySelectorAll('.lkcb-tag-box')];
    const values = () =>
      normalizeTags(boxes().map((box) => box.querySelector('input').value));
    let boxesHidden = false; // 「无标签」勾选时整组框收起（行内的复选框本身留着）
    function syncControls() {
      const count = boxes().length;
      add.hidden = boxesHidden || count >= MAX_TAGS;
      for (const box of boxes()) {
        box.hidden = boxesHidden;
        box.querySelector('.lkcb-tag-remove').hidden = count <= 1;
      }
    }
    function appendBox(value = '') {
      if (boxes().length >= MAX_TAGS) return null;
      add.insertAdjacentHTML(
        'beforebegin',
        '<span class="lkcb-tag-box"><input type="text" autocomplete="off" class="lkcb-tag-input" title="标签需完全一致才命中（子串不命中）" /><button type="button" class="lkcb-tag-remove" title="移除该标签框">×</button></span>',
      );
      const box = add.previousElementSibling;
      const input = box.querySelector('input');
      input.value = value; // 用户数据只走 value，不进 HTML 模板
      box.querySelector('.lkcb-tag-remove').addEventListener('click', () => {
        box.remove();
        syncControls();
      });
      syncControls();
      return input;
    }
    add.addEventListener('click', () => appendBox()?.focus());

    const seed = normalizeTags(initialTags);
    (seed.length ? seed : ['']).forEach((tag) => appendBox(tag));

    return {
      root: container,
      get values() {
        return values();
      },
      reset() {
        boxes().forEach((box) => box.remove());
        appendBox();
      },
      setBoxesHidden(hidden) {
        boxesHidden = hidden;
        syncControls();
      },
    };
  }

  // ===== 规则列表 =====

  function ruleButton(text, className, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', handler);
    return btn;
  }

  // 规则行：勾选启停 + 完整文本（停用画删除线）+ 编辑/删除；编辑表单挂在本行下方
  function buildRuleRow(rule, index) {
    const li = document.createElement('li');
    li.classList.toggle('lkcb-off', rule.enabled === false);
    // prettier-ignore
    li.innerHTML = '<div class="lkcb-rule-line"><input type="checkbox" title="启用/停用该规则（需与总开关同时打开才生效）" /><span class="lkcb-rule-text"></span><button type="button" class="lkcb-edit" title="编辑该规则">编辑</button><button type="button" class="lkcb-remove" title="删除该规则">×</button></div>';
    const [check, text, edit, remove] = li.firstElementChild.children;
    check.checked = rule.enabled !== false;
    text.textContent = ruleLabel(rule); // 规则文本含用户输入，只走 textContent
    edit.hidden = index === editingIndex;
    check.addEventListener('change', () => {
      const rules = [...settings.rules];
      rules[index] = { ...rules[index], enabled: check.checked };
      // 只改这一行：就地更新样式，不重建列表，展开中的编辑表单不受影响
      li.classList.toggle('lkcb-off', !check.checked);
      updateSettings({ rules }, false);
    });
    edit.addEventListener('click', () => {
      editingIndex = index;
      renderRules();
    });
    remove.addEventListener('click', () =>
      updateSettings(
        { rules: settings.rules.filter((_, i) => i !== index) },
        true,
      ),
    );
    if (index === editingIndex) {
      li.classList.add('lkcb-editing');
      const saveEdit = () => {
        const rules = [...settings.rules];
        rules[index] = { ...rules[index], ...editForm.read() };
        updateSettings({ rules }, true);
      };
      editForm = createRuleForm(rule, saveEdit);
      editForm.root.classList.add('lkcb-rule-edit');
      editForm.actions.append(
        ruleButton('保存修改', 'btn btn-primary lkcb-save', saveEdit),
        ruleButton('取消', 'btn btn-default lkcb-cancel-edit', () => {
          editingIndex = -1;
          renderRules();
        }),
      );
      li.append(editForm.root);
    }
    return li;
  }

  function renderStatus() {
    const total = settings.rules.length;
    const active = settings.rules.filter((r) => r.enabled !== false).length;
    const state = !settings.enabled
      ? `已暂停，${total} 条规则`
      : total === 0
        ? '已启用，还没有规则'
        : `已启用，${active}/${total} 条规则生效`;
    document.getElementById('lkcb-status').textContent =
      state + (catTreeFailed ? ' · 类别列表没拉到' : '');
    document.getElementById('lkcb-enabled').checked = settings.enabled;
    document.getElementById('lkcb-hideMode').value = settings.hideMode;
  }

  // 一次性提示：短暂占用状态行（导入成功/失败），到时恢复常规状态文案
  function flashStatus(text) {
    clearTimeout(statusTimer);
    document.getElementById('lkcb-status').textContent = text;
    statusTimer = setTimeout(renderStatus, 2400);
  }

  function renderRules() {
    editForm = null;
    const list = document.getElementById('lkcb-rules');
    list.replaceChildren(...settings.rules.map(buildRuleRow));
    document.getElementById('lkcb-empty').hidden = settings.rules.length > 0;
    renderStatus();
  }

  // ===== 面板 =====

  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'lkcb-overlay';
    // prettier-ignore
    overlay.innerHTML = `<div id="lkcb-panel" role="dialog" aria-label="屏蔽规则">
<div class="lkcb-header">
    <span class="lkcb-head">屏蔽规则</span>
    <span id="lkcb-status" class="lkcb-status">正在读取设置</span>
    <button id="lkcb-close" type="button" title="关闭（Esc）">×</button>
</div>
<div class="lkcb-body">
    <div class="lkcb-row">
        <input id="lkcb-enabled" type="checkbox" />
        <label for="lkcb-enabled">启用屏蔽</label>
        <select id="lkcb-hideMode"><option value="dim">淡化显示</option><option value="hide">直接隐藏</option></select>
    </div>
    <ul id="lkcb-rules" class="lkcb-rules"></ul>
    <div id="lkcb-empty" class="lkcb-empty" hidden>还没有规则</div>
</div>
<div class="lkcb-footer">
    <button id="lkcb-import" class="btn btn-default" type="button" title="从 JSON 文件导入规则（替换当前全部规则）">导入</button>
    <button id="lkcb-export" class="btn btn-default" type="button" title="把当前规则导出成 JSON 文件">导出</button>
    <button id="lkcb-clear" class="btn btn-default" type="button">清空</button>
</div>
<input type="file" accept=".json,application/json" hidden />`;
    document.body.appendChild(overlay);

    const panel = overlay.querySelector('#lkcb-panel');
    const body = panel.querySelector('.lkcb-body');
    const on = (selector, event, handler) =>
      panel.querySelector(selector).addEventListener(event, handler);

    addForm = createRuleForm(null, addRule);
    addForm.root.id = 'lkcb-add-form';
    const addBtn = ruleButton('添加规则', 'btn btn-primary', addRule);
    addBtn.id = 'lkcb-add';
    addForm.actions.append(addBtn);
    body.insertBefore(addForm.root, panel.querySelector('#lkcb-rules'));

    on('#lkcb-close', 'click', closePanel);
    on('#lkcb-enabled', 'change', (e) =>
      updateSettings({ enabled: e.target.checked }, false),
    );
    on('#lkcb-hideMode', 'change', (e) =>
      updateSettings({ hideMode: e.target.value }, false),
    );
    on('#lkcb-clear', 'click', () => updateSettings({ rules: [] }, true));
    on('#lkcb-export', 'click', () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(settings.rules, null, 2)], {
          type: 'application/json;charset=utf-8',
        }),
      );
      Object.assign(document.createElement('a'), {
        href: url,
        download: 'linuxdo-rules.json',
      }).click();
      URL.revokeObjectURL(url);
    });
    // 导入：与导出的 JSON 同格式（规则数组），复用存储那套归一化与去重
    const fileInput = overlay.querySelector('input[type="file"]');
    on('#lkcb-import', 'click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = ''; // 清掉选中值，同一个文件可以反复导入
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (e) {
        return flashStatus('导入失败：不是合法的 JSON 文件');
      }
      const rules = normalizeRules(parsed);
      if (!rules.length) return flashStatus('导入失败：文件里没有有效规则');
      updateSettings({ rules }, true);
      flashStatus(`已导入 ${rules.length} 条规则`);
    });
    // 面板内容滚动 / 窗口缩放时让类别下拉浮层跟随输入框
    body.addEventListener('scroll', () => activePicker?.reposition());
    window.addEventListener('resize', () => activePicker?.reposition());
    renderRules();
  }

  function addRule() {
    const rule = addForm.read();
    if (isEmptyRule(rule)) return; // 至少填一项
    updateSettings({ rules: [...settings.rules, rule] }, true);
    addForm.reset();
    addForm.title.focus();
  }

  const overlayEl = () => document.getElementById('lkcb-overlay');
  const isPanelOpen = () => !!overlayEl()?.classList.contains('lkcb-open');

  const openPanel = () => overlayEl()?.classList.add('lkcb-open');

  // 关闭即复位编辑态（展开中的编辑表单会随列表重建丢弃）
  function closePanel() {
    if (!isPanelOpen()) return;
    overlayEl().classList.remove('lkcb-open');
    editingIndex = -1;
    renderRules();
  }

  const togglePanel = () => (isPanelOpen() ? closePanel() : openPanel());

  // Ctrl+Q 切换面板，Esc / 点遮罩空白关闭；油猴菜单命令兜底
  function registerShortcuts() {
    document.addEventListener('keydown', (event) => {
      const isToggle =
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'q';
      if (isToggle) {
        event.preventDefault();
        togglePanel();
      } else if (event.key === 'Escape') closePanel();
    });
    overlayEl().addEventListener('click', (event) => {
      if (event.target.id === 'lkcb-overlay') closePanel();
    });
    if (typeof GM_registerMenuCommand === 'function')
      GM_registerMenuCommand('屏蔽规则（Ctrl+Q）', openPanel);
  }

  // ===== 观察器 =====

  // 从任意节点向上找到最外层行（搜索结果里内层也带 topic-id）
  function outermostRow(el) {
    let host = el.parentElement?.closest(TOPIC_SELECTORS);
    while (host) {
      const outer = host.parentElement?.closest(TOPIC_SELECTORS);
      if (!outer) return host;
      host = outer;
    }
    return null;
  }

  // 清掉元素自身与后代上残留的状态（Ember 会回收复用行节点）
  const staleClean = (el) => {
    el.removeAttribute('data-lkcb-state');
    clearNestedState(el);
  };

  // 新增行在浏览器绘制前同步处理，避免「先显示后隐藏」的闪现与跳动。
  // 站点填一行内容是「骨架 → 标题 → 徽章 → 图片」分多次插入，同一批 mutation 里同一行
  // 会被反复触及，所以先按行收集去重，批次末尾每行只判定一次（内容没变的行由指纹缓存复用）
  function handleAddedNodes(mutations) {
    if (!ready) return; // 类别树未就绪时先不落状态，避免算两遍造成页面跳两次
    const active = settings.enabled && ruleCache.length > 0;
    const rows = new Set(); // 需要判定的最外层行
    const nested = new Set(); // 需要清掉残留状态的嵌套行
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // 站点填标题/数字用的是文本节点：只提升宿主行，不必查后代（文本没有后代）
        if (node.nodeType === Node.TEXT_NODE) {
          const host = node.parentElement && outermostRow(node.parentElement);
          if (host) rows.add(host);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node;
        // 自身 UI 跳过：观察器不处理 lkcb- 前缀节点，避免自我触发
        if (el.id.startsWith('lkcb-')) continue;
        if (!active) {
          staleClean(el);
          continue;
        }
        if (el.matches(TOPIC_SELECTORS)) {
          // 未挂载的节点父链不完整，可能被误判为最外层行；等挂载时随子树统一处理
          if (el.parentElement?.closest(TOPIC_SELECTORS)) nested.add(el);
          else if (el.isConnected) rows.add(el);
          continue;
        }
        // 所属行内容已变化。这里不读 el.textContent：大容器上会遍历整棵子树，代价太高；
        // 被顺带触及但内容没变的行由指纹缓存直接命中，不会白算
        const host = outermostRow(el);
        if (host) rows.add(host);
        for (const row of el.querySelectorAll(TOPIC_SELECTORS)) {
          if (row.parentElement?.closest(TOPIC_SELECTORS)) nested.add(row);
          else rows.add(row);
        }
      }
    }
    for (const row of nested) {
      staleClean(row);
      rows.delete(row);
    }
    for (const row of rows) {
      applyTopicState(row, findMatchedRule(row));
      clearNestedState(row);
    }
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(handleAddedNodes);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ===== 启动 =====

  // 登录后头部才存在 #current-user（本站实测）。未登录时不过滤、不注入任何 UI
  const isLoggedIn = () => !!document.getElementById('current-user');

  // 未登录时挂观察器等登录（SPA 登录不刷新页面）
  function waitForLogin() {
    const watcher = new MutationObserver(() => {
      if (isLoggedIn()) {
        watcher.disconnect();
        init();
      }
    });
    watcher.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  async function init() {
    if (!isLoggedIn()) {
      waitForLogin();
      return;
    }
    injectStyles();
    await loadSettings();
    buildPanel();
    registerShortcuts();
    startObserver();
    // 只有「所有等级」规则依赖类别树：没有这类规则就先就绪、立刻过滤；否则等树到齐
    // 再统一判定一次，避免同一行先按不完整的分类集合算一遍、树到了又跳一次
    ready = !settings.rules.some((rule) => rule.allLevels);
    await loadCategoryTree();
    ready = true;
    scanTopics();
  }

  init();
})();
