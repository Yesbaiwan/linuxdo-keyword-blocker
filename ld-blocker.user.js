// ==UserScript==
// @name         Linux.do Keyword Blocker
// @namespace    https://linux.do/
// @version      2.4.1
// @description  用「类别/标签/标题」规则屏蔽 linux.do 上不想看到的帖子（需登录使用）
// @author       linuxdo-keyword-blocker
// @match        https://linux.do/*
// @homepageURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker
// @downloadURL  https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @updateURL    https://github.com/Yesbaiwan/linuxdo-keyword-blocker/raw/main/ld-blocker.user.js
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 幂等守卫：同文档重复注入（如测试时先 eval 本体又 eval 测试）会产生双实例
  // 互踩渲染，第二次注入直接跳过
  if (window.__lkcbLoaded) return;
  window.__lkcbLoaded = true;

  const STORAGE_KEY = 'linuxdo-keyword-blocker-settings';
  // 站点类别树缓存：/site.json 体积大，缓存 7 天避免每次页面加载都拉
  const CATEGORY_CACHE_KEY = 'linuxdo-keyword-blocker-categories';
  const CATEGORY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  // 缓存格式版本：格式变化时 +1 使旧缓存作废。v2 起读取时逐条校验
  // id/name/parent 字段，旧版脚本写入的残缺树会直接被拒并重拉，
  // 避免残缺 parent 把下拉缩进搞乱
  const CATEGORY_CACHE_VERSION = 2;
  // 每条规则 { category: number|null, tag: string, title: string, enabled: boolean }，
  // 已填字段全部命中才算命中，至少填一项；enabled 是该规则的独立开关，
  // 与总开关同时打开才参与匹配
  const DEFAULT_SETTINGS = {
    enabled: true,
    rules: [],
    // 默认淡化显示而非直接隐藏：帖子变暗但还在信息流里，误屏蔽可见可改；
    // 已存过设置的用户保持自己的选择
    hideMode: 'dim',
  };

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  // 「屏蔽规则」标签当前是否处于激活状态（头像菜单内容区切换到规则管理视图）
  let rulesTabActive = false;

  const TOPIC_SELECTORS = [
    '.fps-result',
    '.latest-topic-list-item',
    '.topic-list-item',
    '.topic-post',
    '[data-topic-id]',
  ].join(',');

  // 标题提取按优先级逐个尝试：列表行是 .title，搜索结果是 .topic-title，
  // 最后的 a[href^='/t/'] 兜底
  const TITLE_SELECTORS = ['.title', '.topic-title', "a[href^='/t/']"];

  // 登录后点击右上角头像出现的用户菜单；未登录时不存在，因此无入口
  const USER_MENU_PANEL_SELECTOR = '.user-menu.menu-panel';
  // 入口做成和「个人资料」同款的标签按钮，插在它下面（标签列最底部）
  const PROFILE_TAB_ID = 'user-menu-button-profile';
  const MENU_TABS_FALLBACK_SELECTOR =
    '.user-menu.menu-panel .menu-tabs-container';
  // 这些节点被移除意味着整个菜单面板被销毁（关闭）
  const MENU_CLOSE_MARKERS =
    '.user-menu.menu-panel, .user-menu-dropdown-wrapper';

  // ===== 类别树 =====

  // byId: Map<id, {id, name, parent}>；children: Map<父 id, 子 id[]>
  const catById = new Map();
  const catChildren = new Map();
  const catOrder = []; // 顶级分类 id，按展示顺序

  function buildCategoryIndex(cats) {
    catById.clear();
    catChildren.clear();
    catOrder.length = 0;
    if (!cats || !cats.length) return;
    for (const c of cats) {
      const parent = c.parent == null ? null : Number(c.parent);
      catById.set(c.id, { id: c.id, name: c.name, parent });
    }
    for (const c of catById.values()) {
      if (c.parent == null || !catById.has(c.parent)) {
        // 父分类不在可见列表（受限或已删除）时按顶级展示，保证不丢项
        c.parent = null;
        catOrder.push(c.id);
      } else {
        const arr = catChildren.get(c.parent) || [];
        arr.push(c.id);
        catChildren.set(c.parent, arr);
      }
    }
  }

  // 下拉选项与规则胶囊共用的展示名：有子分类的分类追加「（不带等级）」——
  // 选中它只命中直接发在该分类下的帖子（行徽章只带话题自身分类 ID），
  // 避免误以为会屏蔽整个大类
  function categoryName(id) {
    const cat = catById.get(id);
    if (!cat) return String(id);
    return catChildren.get(id)?.length ? `${cat.name}（不带等级）` : cat.name;
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[ch],
    );
  }

  // 缓存优先（7 天）拉取站点完整类别树。失败时保持空索引：下拉仅剩
  // 「不按类别筛选」，无法新增类别规则，标题/标签规则不受影响
  async function loadCategoryTree() {
    let loaded = false;
    try {
      const cached = await GM.getValue(CATEGORY_CACHE_KEY, null);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (
          parsed?.v === CATEGORY_CACHE_VERSION &&
          Array.isArray(parsed?.categories) &&
          Date.now() - parsed.ts < CATEGORY_CACHE_TTL &&
          // 逐条校验字段完整性，残缺树宁可重拉也不用
          parsed.categories.every(
            (c) =>
              typeof c?.id === 'number' &&
              typeof c?.name === 'string' &&
              (c?.parent == null || typeof c.parent === 'number'),
          )
        ) {
          buildCategoryIndex(parsed.categories);
          loaded = true;
        }
      }
    } catch (e) {
      // 缓存损坏当作没有，走后续拉取
    }
    if (!loaded) {
      try {
        const res = await fetch('/site.json', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error('site.json ' + res.status);
        const data = await res.json();
        const cats = (data?.categories || []).map((c) => ({
          id: c.id,
          name: c.name,
          parent: c.parent_category_id ?? null,
        }));
        if (cats.length) {
          buildCategoryIndex(cats);
          loaded = true;
          // 缓存写失败不影响本次会话，下次页面加载再拉
          GM.setValue(
            CATEGORY_CACHE_KEY,
            JSON.stringify({
              v: CATEGORY_CACHE_VERSION,
              ts: Date.now(),
              categories: cats,
            }),
          ).catch(() => {});
        }
      } catch (e) {
        // 网络失败保持空索引，下次页面加载再试
      }
    }
    if (loaded) {
      bumpMatchVersion();
      scanTopics();
      renderRulesTab();
    }
  }

  // ===== storage =====

  async function loadSettings() {
    const stored = await GM.getValue(STORAGE_KEY, null);
    let parsed = {};
    try {
      if (stored) parsed = JSON.parse(stored);
    } catch (e) {
      // 存储内容损坏时保持空对象，回退默认设置，别让整个脚本挂掉
    }
    // 旧版关键词存储迁移：每个关键词 ≈ 一条仅填标题的规则
    if (!Array.isArray(parsed.rules) && Array.isArray(parsed.keywords)) {
      parsed.rules = parsed.keywords.map((k) => ({
        category: null,
        tag: '',
        title: String(k),
      }));
    }
    // 处理模式只认两个已知值，其余（手改存储/未知格式）回退默认
    if (parsed.hideMode !== 'hide' && parsed.hideMode !== 'dim') {
      parsed.hideMode = DEFAULT_SETTINGS.hideMode;
    }
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      rules: normalizeRules(parsed.rules),
    };
    bumpMatchVersion();
  }

  async function saveSettings(patch) {
    const next = { ...settings, ...patch };
    next.rules = normalizeRules(next.rules);
    settings = next;
    bumpMatchVersion();
    await GM.setValue(STORAGE_KEY, JSON.stringify(settings));
    renderRulesTab();
    scanTopics();
  }

  // ===== matching =====

  function normalizeText(value) {
    return String(value || '').toLocaleLowerCase();
  }

  function normalizeRules(rules) {
    const seen = new Set();
    const out = [];
    for (const rule of rules || []) {
      const raw = rule?.category;
      let category = raw == null || raw === '' ? null : parseInt(raw, 10);
      if (Number.isNaN(category)) category = null;
      const tag = String(rule?.tag || '').trim();
      const title = String(rule?.title || '').trim();
      if (category == null && !tag && !title) continue;
      const key = JSON.stringify([category, tag, title]);
      if (seen.has(key)) continue;
      seen.add(key);
      // enabled 缺省视为启用，旧版存储迁移无需补字段
      out.push({ category, tag, title, enabled: rule?.enabled !== false });
    }
    return out;
  }

  function ruleLabel(rule) {
    const parts = [];
    if (rule.category != null)
      parts.push('类别:' + categoryName(rule.category));
    if (rule.tag) parts.push('标签:' + rule.tag);
    if (rule.title) parts.push('标题:' + rule.title);
    return parts.join(' + ');
  }

  // 规则匹配缓存，设置或类别树变更时重算。类别只存所选分类自身的徽章 ID：
  // 帖子行徽章只带话题所属分类的 ID，选父分类就只命中直接发在父分类下的帖子
  //（不带等级），不连带子分类。刻意不做「父分类连带全部子分类」：屏蔽某一级
  // 就单独选那一级；整类屏蔽交给 Discourse 自带的分类静音，大范围屏蔽会让
  // 信息流大量消失、站点不停加载新帖甚至触发限流
  let matchVersion = 0;
  let ruleCache = [];

  function rebuildRuleCache() {
    // 停用的规则不参与匹配：总开关打开 且 规则自身勾选启用才生效
    ruleCache = settings.rules
      .filter((rule) => rule.enabled !== false)
      .map((rule) => ({
        label: ruleLabel(rule),
        category: rule.category == null ? null : String(rule.category),
        tag: normalizeText(rule.tag),
        title: normalizeText(rule.title),
      }));
  }

  function bumpMatchVersion() {
    rebuildRuleCache();
    matchVersion++;
  }

  // 匹配结果缓存：话题 id（或无 id 时的节点）→ 命中规则的展示文本，设置变更后整批失效
  const matchCache = new Map();
  const nodeMatchCache = new WeakMap();

  // 按优先级逐个选择器取第一个非空文本。不能用逗号合并的 querySelector：
  // 它按文档序返回第一个匹配——置顶帖的「置顶」切换按钮（空文本的 a）在文档序上
  // 先于标题出现，会把标题顶掉，导致置顶帖永远无法按标题规则过滤。
  function firstNonEmptyText(topic, selectors) {
    for (const sel of selectors) {
      const t = topic.querySelector(sel)?.textContent.trim();
      if (t) return t;
    }
    return '';
  }

  // 类别只认徽章上的 data-category-id 数字：显示文字会随站点改版变，ID 不会；
  // 且老版 Discourse 的 .category-name 类在本站根本不存在，按名字匹配必然落空。
  // 子分类页面（如 /c/develop/develop-lv1/20）行内完全没有徽章，类别规则在该
  // 场景天然不命中，标题/标签规则照常工作。
  function getTopicCategoryIds(topic) {
    const set = new Set();
    topic
      .querySelectorAll('span.badge-category[data-category-id]')
      .forEach((el) => {
        const id = el.getAttribute('data-category-id');
        if (id) set.add(id);
      });
    return set;
  }

  function getTopicTags(topic) {
    return [...topic.querySelectorAll('a.discourse-tag')]
      .map((el) => normalizeText(el.textContent.trim()))
      .filter(Boolean);
  }

  function findMatchedRule(topic, force) {
    if (ruleCache.length === 0) return null;
    const id = topic.dataset.topicId;
    let entry = id ? matchCache.get(id) : nodeMatchCache.get(topic);
    if (!force && entry && entry.v === matchVersion) return entry.rule;

    const title = normalizeText(firstNonEmptyText(topic, TITLE_SELECTORS));
    const catIds = getTopicCategoryIds(topic);
    const tags = getTopicTags(topic);
    let rule = null;
    for (const cached of ruleCache) {
      // 规则内已填字段必须全部命中：类别按徽章 ID 精确比对（只认所选分类
      // 本身），标签/标题按包含匹配，大小写不敏感
      if (cached.category != null && !catIds.has(cached.category)) continue;
      if (cached.tag && !tags.some((tag) => tag.includes(cached.tag))) continue;
      if (cached.title && !title.includes(cached.title)) continue;
      rule = cached.label;
      break;
    }
    entry = { v: matchVersion, rule };
    if (id) matchCache.set(id, entry);
    else nodeMatchCache.set(topic, entry);
    return rule;
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
      .querySelectorAll('[data-lkcb-state],[data-lkcb-match]')
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
      applyTopicState(topic, findMatchedRule(topic));
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
.panel-body-contents[data-lkcb-view="rules"] .quick-access-panel:not(#lkcb-quick-access) { display: none !important; }
.panel-body-contents[data-lkcb-view="rules"] #lkcb-quick-access { display: flex; flex-direction: column; justify-content: flex-start; max-height: 100%; overflow: hidden; }
#lkcb-quick-access .lkcb-status { margin: 0 0 10px; font-size: 12px; color: var(--primary-medium, #919191); }
#lkcb-quick-access .lkcb-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#lkcb-quick-access .lkcb-row label { font-size: 13px; white-space: nowrap; cursor: pointer; }
#lkcb-quick-access .lkcb-grow { flex: 1; min-width: 0; }
#lkcb-quick-access input[type="text"] { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--secondary, #ffffff); color: var(--primary, #222222); }
#lkcb-quick-access input[type="text"]:focus { outline: 2px solid var(--tertiary, #0088cc); outline-offset: -1px; }
#lkcb-quick-access select { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--secondary, #ffffff); color: var(--primary, #222222); }
#lkcb-quick-access #lkcb-add { flex: 1; }
#lkcb-quick-access .lkcb-cat-picker { min-width: 0; }
#lkcb-quick-access .lkcb-row .lkcb-cat-picker { flex: 1; }
#lkcb-quick-access .lkcb-cat-input-row { position: relative; display: flex; }
#lkcb-quick-access .lkcb-cat-picker input { padding-right: 26px; }
#lkcb-quick-access .lkcb-cat-clear { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); border: none; background: none; padding: 2px 8px; font-size: 14px; line-height: 1; color: var(--primary-medium, #919191); cursor: pointer; }
#lkcb-quick-access .lkcb-cat-clear:hover { color: var(--danger, #ff5555); }
#lkcb-quick-access .lkcb-cat-list { margin-top: 4px; max-height: 200px; overflow-y: auto; background: var(--secondary, #ffffff); border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; }
#lkcb-quick-access .lkcb-cat-item { padding: 7px 10px; font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#lkcb-quick-access .lkcb-cat-item:hover { background: var(--primary-very-low, #f8f8f8); }
#lkcb-quick-access .lkcb-cat-item.lkcb-cat-none { color: var(--primary-medium, #919191); }
#lkcb-quick-access ul.lkcb-rules { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; flex-wrap: nowrap; gap: 6px; flex: 0 1 auto; min-height: 0; overflow-y: auto; }
#lkcb-quick-access ul.lkcb-rules li { box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; background: var(--primary-very-low, #f8f8f8); font-size: 13px; }
#lkcb-quick-access ul.lkcb-rules li.lkcb-editing { border-color: var(--tertiary, #0088cc); }
#lkcb-quick-access .lkcb-rule-line { display: flex; align-items: flex-start; gap: 6px; }
#lkcb-quick-access .lkcb-rule-text { flex: 1; min-width: 0; line-height: 1.5; word-break: break-word; }
#lkcb-quick-access li.lkcb-off .lkcb-rule-text { opacity: 0.45; text-decoration: line-through; }
#lkcb-quick-access .lkcb-rule-line input[type="checkbox"] { flex-shrink: 0; margin: 0; }
#lkcb-quick-access .lkcb-rule-line button { flex-shrink: 0; border: none; background: none; padding: 0; color: var(--primary-medium, #919191); font-size: 12px; line-height: 1.5; cursor: pointer; }
#lkcb-quick-access .lkcb-rule-line button.lkcb-edit:hover { color: var(--tertiary, #0088cc); }
#lkcb-quick-access .lkcb-rule-line button.lkcb-remove { font-size: 14px; }
#lkcb-quick-access .lkcb-rule-line button.lkcb-remove:hover { color: var(--danger, #ff5555); }
#lkcb-quick-access .lkcb-rule-edit { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--primary-low, #dddddd); }
#lkcb-quick-access .lkcb-rule-edit .lkcb-row { margin-bottom: 0; }
#lkcb-quick-access .lkcb-rule-edit .lkcb-save { flex: 1; }
#lkcb-quick-access .lkcb-empty { margin-bottom: 10px; padding: 14px; text-align: center; font-size: 13px; color: var(--primary-medium, #919191); border: 1px solid var(--primary-low, #dddddd); border-radius: 4px; }
#lkcb-quick-access .lkcb-footer { display: flex; justify-content: flex-end; gap: 6px; }`;
    document.documentElement.appendChild(style);
  }

  // ===== 头像菜单内的规则管理视图 =====

  // 构建菜单内容区里的管理界面：容器复用原生 quick-access-panel 类，
  // 按钮复用 Discourse 的 btn/btn-primary/btn-default，颜色走主题变量，观感与原生一致。
  // 类别选择用自带搜索的 picker（输入即过滤、点选即选中），不再单设搜索框
  function buildRulesTab() {
    const container = document.createElement('div');
    container.id = 'lkcb-quick-access';
    container.className = 'quick-access-panel';
    // prettier-ignore
    container.innerHTML = `<p id="lkcb-status" class="lkcb-status">正在读取设置</p>
<div class="lkcb-row">
    <input id="lkcb-enabled" type="checkbox" />
    <label for="lkcb-enabled">启用屏蔽</label>
    <select id="lkcb-hideMode" class="lkcb-grow">
        <option value="dim">淡化显示</option>
        <option value="hide">直接隐藏</option>
    </select>
</div>
<div class="lkcb-row" id="lkcb-form-cat"></div>
<div class="lkcb-row">
    <input id="lkcb-rule-tag" type="text" autocomplete="off" placeholder="标签（包含即命中）" />
    <input id="lkcb-rule-title" type="text" autocomplete="off" placeholder="标题（包含即命中）" />
</div>
<div class="lkcb-row">
    <button id="lkcb-add" class="btn btn-primary" type="button">添加规则</button>
</div>
<ul id="lkcb-rules" class="lkcb-rules"></ul>
<div id="lkcb-empty" class="lkcb-empty" hidden>还没有规则</div>
<div class="lkcb-footer">
    <button id="lkcb-export" class="btn btn-default" type="button">导出</button>
    <button id="lkcb-clear" class="btn btn-default" type="button">清空</button>
</div>`;
    // 视图在 Discourse 菜单内部：不拦截的话，点击会被菜单委托当成菜单项路由走
    //（实测点规则的 × 会跳到个人资料页），键盘输入会触发全局快捷键。
    // 自身处理器绑定在子元素上，冒泡到容器时早已执行完毕，不受影响。
    container.addEventListener('click', (event) => event.stopPropagation());
    container.addEventListener('keydown', (event) => event.stopPropagation());
    bindRulesTab(container);
    return container;
  }

  // 可搜索类别选择器：输入即过滤、点选或回车即选中。搜索词是临时的——
  // 失焦未选择则恢复原值，只有显式点选或点 × 清除才改变选中结果。
  // 下拉是文档流内的内联展开（非浮层）：Discourse 菜单面板带 slide-in
  // transform 动画，会劫持 fixed/absolute 浮层的定位与裁剪（fixed 下拉
  // 实测弹不出来），内联展开零环境依赖
  function createCategoryPicker(initialId, onChange) {
    const root = document.createElement('div');
    root.className = 'lkcb-cat-picker';
    // prettier-ignore
    root.innerHTML = `<div class="lkcb-cat-input-row"><input class="lkcb-cat-input" type="text" autocomplete="off" placeholder="搜索或选择类别" />
<button type="button" class="lkcb-cat-clear" title="清除已选类别" hidden>×</button></div>
<div class="lkcb-cat-list" hidden></div>`;
    const input = root.querySelector('input');
    const clearBtn = root.querySelector('.lkcb-cat-clear');
    const list = root.querySelector('.lkcb-cat-list');
    let selectedId = initialId == null ? null : Number(initialId);
    let searching = false; // 正在输入搜索词（尚未确认选择）

    function renderList(query) {
      const q = normalizeText(query).trim();
      const items = [
        '<div class="lkcb-cat-item lkcb-cat-none" data-id="">不按类别筛选</div>',
      ];
      const walk = (id, depth) => {
        const cat = catById.get(id);
        if (!cat) return;
        const name = categoryName(id);
        if (!q || normalizeText(name).includes(q)) {
          items.push(
            `<div class="lkcb-cat-item" data-id="${cat.id}" style="padding-left:${10 + depth * 16}px">${escapeHtml(name)}</div>`,
          );
        }
        for (const childId of catChildren.get(id) || [])
          walk(childId, depth + 1);
      };
      for (const topId of catOrder) walk(topId, 0);
      if (items.length === 1) {
        items.push(
          `<div class="lkcb-cat-item lkcb-cat-none">${catById.size ? '没有匹配的类别' : '类别列表不可用'}</div>`,
        );
      }
      list.innerHTML = items.join('');
    }

    function syncInput() {
      input.value = selectedId == null ? '' : categoryName(selectedId);
      clearBtn.hidden = selectedId == null;
    }

    function openList() {
      renderList(searching ? input.value : '');
      list.hidden = false;
    }

    function closeList() {
      list.hidden = true;
      searching = false;
      syncInput();
    }

    function choose(id) {
      searching = false;
      selectedId = id == null || id === '' ? null : Number(id);
      closeList();
      onChange?.(selectedId);
    }

    input.addEventListener('focus', () => {
      input.select();
      openList();
    });
    input.addEventListener('input', () => {
      searching = true;
      openList();
    });
    // 阻止 mousedown 默认行为，避免点选项前输入框先失焦把下拉收起
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.lkcb-cat-item');
      if (item) choose(item.dataset.id);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = list.querySelector('.lkcb-cat-item[data-id]');
        if (first && !list.hidden) choose(first.dataset.id);
      }
    });
    input.addEventListener('blur', closeList);
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => choose(null));

    syncInput();
    return {
      root,
      get value() {
        return selectedId;
      },
      reset() {
        selectedId = null;
        syncInput();
      },
    };
  }

  // 行内编辑态：正在展开编辑表单的规则下标（-1 = 无）与其表单草稿。
  // 草稿让重渲染（如勾选其他规则触发 saveSettings 全量重建列表）时
  // 未保存的输入不丢失
  let editingIndex = -1;
  let editDraft = null;

  function startEdit(index) {
    const rule = settings.rules[index];
    if (!rule) return;
    editingIndex = index;
    editDraft = { category: rule.category, tag: rule.tag, title: rule.title };
    renderRulesTab();
  }

  function cancelEdit() {
    editingIndex = -1;
    editDraft = null;
    renderRulesTab();
  }

  async function saveEdit() {
    const index = editingIndex;
    const draft = editDraft;
    if (index < 0 || !draft) return;
    if (draft.category == null && !draft.tag.trim() && !draft.title.trim()) {
      cancelEdit(); // 全空相当于取消
      return;
    }
    editingIndex = -1;
    editDraft = null;
    const rules = [...settings.rules];
    rules[index] = {
      ...rules[index],
      category: draft.category,
      tag: draft.tag,
      title: draft.title,
    };
    await saveSettings({ rules });
  }

  // 规则行：勾选启停 + 完整文本（换行显示不截断，停用画删除线）+ 编辑/删除。
  // editing 为真时隐藏编辑按钮（该行已展开编辑表单）
  function buildRuleRow(rule, index, editing = false) {
    const li = document.createElement('li');
    if (rule.enabled === false) li.classList.add('lkcb-off');
    const line = document.createElement('div');
    line.className = 'lkcb-rule-line';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = rule.enabled !== false;
    check.title = '启用/停用该规则（需与总开关同时打开才生效）';
    check.setAttribute('aria-label', '启用该规则');
    check.addEventListener('change', () => {
      const rules = [...settings.rules];
      rules[index] = { ...rules[index], enabled: check.checked };
      saveSettings({ rules });
    });
    const text = document.createElement('span');
    text.className = 'lkcb-rule-text';
    text.textContent = ruleLabel(rule);
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'lkcb-edit';
    editBtn.textContent = '编辑';
    editBtn.title = '编辑该规则';
    editBtn.hidden = editing;
    editBtn.addEventListener('click', () => startEdit(index));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lkcb-remove';
    remove.textContent = '×';
    remove.title = '删除该规则';
    remove.addEventListener('click', () => {
      // 删除编辑中的规则要收起表单；删前面的规则要让编辑下标前移
      if (editingIndex === index) {
        editingIndex = -1;
        editDraft = null;
      } else if (editingIndex > index) {
        editingIndex--;
      }
      saveSettings({ rules: settings.rules.filter((_, j) => j !== index) });
    });
    line.append(check, text, editBtn, remove);
    li.append(line);
    return li;
  }

  // 编辑行：原行下方展开与添加同款的表单（类别 picker + 标签 + 标题），
  // 保存原位替换、取消收起，都在本行完成，不再回填顶部表单
  function buildEditingRow(rule, index) {
    const li = document.createElement('li');
    li.classList.add('lkcb-editing');
    li.append(buildRuleRow(rule, index, true));
    const form = document.createElement('div');
    form.className = 'lkcb-rule-edit';
    const picker = createCategoryPicker(editDraft.category, (value) => {
      editDraft.category = value;
    });
    // 编辑表单的 tag/title/save/cancel 类名（lkcb-edit-tag 等）无样式作用，
    // 是 console-tests 的定位钩子，勿清理
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'lkcb-edit-tag';
    tagInput.placeholder = '标签（包含即命中）';
    tagInput.value = editDraft.tag;
    tagInput.addEventListener('input', () => {
      editDraft.tag = tagInput.value;
    });
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'lkcb-edit-title';
    titleInput.placeholder = '标题（包含即命中）';
    titleInput.value = editDraft.title;
    titleInput.addEventListener('input', () => {
      editDraft.title = titleInput.value;
    });
    const syncDraft = () => {
      editDraft.tag = tagInput.value;
      editDraft.title = titleInput.value;
    };
    for (const el of [tagInput, titleInput]) {
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          syncDraft();
          saveEdit();
        }
      });
    }
    const tagRow = document.createElement('div');
    tagRow.className = 'lkcb-row';
    tagRow.append(tagInput, titleInput);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary lkcb-save';
    save.textContent = '保存修改';
    save.addEventListener('click', () => {
      syncDraft();
      saveEdit();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-default lkcb-cancel-edit';
    cancel.textContent = '取消';
    cancel.addEventListener('click', cancelEdit);
    const btnRow = document.createElement('div');
    btnRow.className = 'lkcb-row';
    btnRow.append(save, cancel);
    form.append(picker.root, tagRow, btnRow);
    li.append(form);
    return li;
  }

  function bindRulesTab(container) {
    // 添加表单的类别选择器（行内编辑的 picker 在 buildEditingRow 里各自创建）
    const picker = createCategoryPicker(null);
    container.querySelector('#lkcb-form-cat').appendChild(picker.root);
    const tag = container.querySelector('#lkcb-rule-tag');
    const title = container.querySelector('#lkcb-rule-title');
    const add = container.querySelector('#lkcb-add');
    const enabled = container.querySelector('#lkcb-enabled');
    const hideMode = container.querySelector('#lkcb-hideMode');
    const clear = container.querySelector('#lkcb-clear');
    const exportBtn = container.querySelector('#lkcb-export');

    const submit = async () => {
      const rule = {
        category: picker.value,
        tag: tag.value,
        title: title.value,
      };
      // 至少填一项；全空时静默返回，由 normalizeRules 再兜底一次
      if (rule.category == null && !rule.tag.trim() && !rule.title.trim())
        return;
      await saveSettings({ rules: [...settings.rules, rule] });
      picker.reset();
      tag.value = '';
      title.value = '';
      title.focus();
    };

    add.addEventListener('click', submit);
    for (const input of [tag, title]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
    }

    enabled.addEventListener('change', () => {
      saveSettings({ enabled: enabled.checked });
    });

    hideMode.addEventListener('change', () => {
      saveSettings({ hideMode: hideMode.value });
    });

    clear.addEventListener('click', () => {
      editingIndex = -1;
      editDraft = null;
      saveSettings({ rules: [] });
    });

    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(settings.rules, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'linuxdo-rules.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  // 渲染管理视图（悬浮面板已移除，仅菜单内唯一实例；target 供激活时定向渲染）。
  // 只刷新状态行与规则列表；添加表单（含 picker）由 buildRulesTab 一次创建，
  // 编辑表单随行重建、值从 editDraft 恢复
  function renderRulesTab(target) {
    const container = target || document.querySelector('#lkcb-quick-access');
    if (!container) return;
    // 编辑中的规则可能已被删除（列表重建/清空），越界即收起编辑表单
    if (editingIndex >= settings.rules.length) {
      editingIndex = -1;
      editDraft = null;
    }
    const status = container.querySelector('#lkcb-status');
    const enabled = container.querySelector('#lkcb-enabled');
    const hideMode = container.querySelector('#lkcb-hideMode');
    const list = container.querySelector('#lkcb-rules');
    const empty = container.querySelector('#lkcb-empty');

    const total = settings.rules.length;
    const activeCount = settings.rules.filter(
      (rule) => rule.enabled !== false,
    ).length;
    let statusText;
    if (!settings.enabled) statusText = `已暂停，${total} 条规则`;
    else if (total === 0) statusText = '已启用，还没有规则';
    else statusText = `已启用，${activeCount}/${total} 条规则生效`;
    status.textContent = statusText;
    enabled.checked = settings.enabled;
    hideMode.value = settings.hideMode;

    list.replaceChildren();
    settings.rules.forEach((rule, i) => {
      list.append(
        i === editingIndex ? buildEditingRow(rule, i) : buildRuleRow(rule, i),
      );
    });
    empty.hidden = total > 0;
  }

  // 「屏蔽规则」标签激活：隐藏原生内容区（打在 panel-body-contents 的 data 属性上，
  // 与帖子行同理，Ember 重写 class 不影响），显示规则管理视图
  function activateRulesView() {
    rulesTabActive = true;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    let view = contents.querySelector('#lkcb-quick-access');
    if (!view) {
      view = buildRulesTab();
      contents.appendChild(view);
    }
    contents.dataset.lkcbView = 'rules';
    // active 态与原生标签切换保持一致：自己点亮，其余熄灭
    contents.querySelectorAll('.user-menu-tab.active').forEach((tab) => {
      if (tab.id !== 'lkcb-menu-entry') tab.classList.remove('active');
    });
    document.getElementById('lkcb-menu-entry')?.classList.add('active');
    renderRulesTab(view);
  }

  // 切回原生标签视图（点任意原生标签时调用）
  function deactivateRulesView() {
    rulesTabActive = false;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    delete contents.dataset.lkcbView;
    document.getElementById('lkcb-menu-entry')?.classList.remove('active');
  }

  // Ember 可能异步重渲染菜单内容（如通知轮询），此时重建视图并恢复激活态
  function assertRulesView(node) {
    if (!rulesTabActive) return;
    // 只关心菜单内部的变更
    if (!node.closest('.user-menu.menu-panel')) return;
    const contents = document.querySelector(
      '.user-menu.menu-panel .panel-body-contents',
    );
    if (!contents) return;
    const view = contents.querySelector('#lkcb-quick-access');
    if (!view || !contents.dataset.lkcbView) {
      activateRulesView();
    }
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
    button.title = '屏蔽规则';
    button.setAttribute('aria-label', '屏蔽规则');
    // prettier-ignore
    button.innerHTML = `<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="M3 4h18l-7 8.5V20l-4 2.5v-10z"/></svg>`;
    button.addEventListener('click', (event) => {
      // 不让事件冒泡给 Discourse，避免被当成标签切换处理
      event.stopPropagation();
      activateRulesView();
    });
    if (profileTab) profileTab.insertAdjacentElement('afterend', button);
    else tabsList.appendChild(button);
  }

  // 新增节点里出现用户菜单面板时立即注入（同步于绘制前，无闪烁）
  function watchForMenuPanel(node) {
    if (
      node.matches(USER_MENU_PANEL_SELECTOR) ||
      node.querySelector(USER_MENU_PANEL_SELECTOR)
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
        if (!rulesTabActive) return;
        const tab = event.target?.closest?.('.user-menu-tab');
        if (tab && tab.id !== 'lkcb-menu-entry') deactivateRulesView();
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
            rulesTabActive = false;
            // 编辑态随视图销毁复位，避免重开后残留半成品表单
            editingIndex = -1;
            editDraft = null;
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
    const active = settings.enabled && ruleCache.length > 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // 自身 UI 跳过：观察器不处理 lkcb- 前缀节点，避免自我触发
        if (node.id.startsWith('lkcb-')) continue;
        assertRulesView(node);
        watchForMenuPanel(node);
        if (!active) {
          // 屏蔽关闭时，清掉 Ember 回收复用节点上可能残留的旧状态
          node.removeAttribute('data-lkcb-state');
          node.removeAttribute('data-lkcb-match');
          node
            .querySelectorAll('[data-lkcb-state],[data-lkcb-match]')
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
            applyTopicState(node, findMatchedRule(node));
            clearNestedState(node);
          }
          continue;
        }
        const descendants = node.querySelectorAll(TOPIC_SELECTORS);
        if (descendants.length === 0) {
          // 行内容通常是骨架先插入、文本后填充；带文本的节点才可能改变匹配结果
          if (!node.textContent.trim()) continue;
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
          applyTopicState(host, findMatchedRule(host, true));
          clearNestedState(host);
        }
        for (const row of descendants) {
          if (row.parentElement?.closest(TOPIC_SELECTORS)) {
            clearNestedState(row);
            continue;
          }
          applyTopicState(row, findMatchedRule(row));
        }
      }
    }
  }

  // ===== 强制登录 =====

  // 登录后 Discourse 头部才存在 #current-user（头像按钮容器，本站实测）。
  // 未登录时脚本完全不工作：不过滤、不注入任何 UI
  function isLoggedIn() {
    return !!document.getElementById('current-user');
  }

  // 未登录时挂观察器等登录（SPA 登录不刷新页面），头部出现 #current-user 即启动
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
    injectMenuEntry();
    scanTopics();
    startObserver();
    loadCategoryTree();
  }

  init();
})();
