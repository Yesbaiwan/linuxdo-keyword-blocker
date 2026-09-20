# 硬性约束

改 `ld-blocker.user.js` 必须遵守的写法。这些不是风格偏好，**违反就会出 bug**，所以每条给一句「违反了会怎样」。

机制层面的「为什么」统一在 [internals.md](internals.md)，这里不重复。行为规则见 [behavior.md](behavior.md)。

## 行状态与 DOM 契约

- **行状态只用 `data-lkcb-state` 属性**，值 `hidden` / `dimmed`，不能用 class —— Ember 会异步重写行的 class，class 方案随时被抹掉。
  - `data-lkcb-state` 的 `hidden` / `dimmed` 与处理模式 `hideMode` 的 `hide` / `dim` 是两回事，必须显式映射。
- **以 `lkcb-` 开头的节点会被观察器跳过** —— 这是脚本自身的防自我触发机制；测试 DOM 不要用该前缀，否则注入的节点测不到。
- **标题选择器不能逗号合并** —— 置顶帖的空文本「置顶」按钮在文档序上先于标题，合并后会取错元素。
- **头部标题 class 是 `.lkcb-head`，表单关键词输入框是 `.lkcb-title`** —— 别混用。

## 站点样式对抗

- **站点 CDN 样式会隐形覆盖** display / flex-direction / justify-content / width（枚举样式表查不到） —— 关键属性一律显式声明，以实测计算样式为准。
- **全局 `select { width: 220px }` 会撑宽下拉** —— 处理模式下拉必须用 `width: fit-content`。
- **站点给 `input` 塞 `margin: 0 0 9px`、给 checkbox 塞四周 margin** —— 面板内一律 `margin: 0` 归零，控件高度统一（输入框 32px、「+」32×32）；标签的 `×` 绝对定位浮在框内右侧。
- **面板内 `hidden` 元素靠 `#lkcb-panel [hidden] { display: none !important }` 兜底** —— `.lkcb-tags` 自带 `display: flex` 会盖掉 `hidden`。

## 面板布局与浮层

- **面板里的框按内容给宽，不撑满整行** —— 类别输入框与标题框等宽：`--lkcb-field-w` 是输入框自身宽度（清除键与箭头在框外），`syncFieldWidth()` 用 canvas 量最长分类展示名 + 子分类缩进算出；`#lkcb-panel` 留 190px 兜底。**改分类展示名格式时同步看这里。**
- **类别下拉候选列表必须 `position: fixed`** —— 不参与面板布局，展开不撑高面板。位置由 `reposition()` 按输入框 rect 算：贴下方，下方不够且上方宽裕时上弹；面板滚动与窗口缩放都要重新贴位（`activePicker` 记当前展开的 picker）。
- **选项的 `mousedown` 要 `preventDefault`** —— 否则点选项前输入框先失焦，下拉会先被收起。

## 观察器与扫描

- **观察器只监听 `childList` + `subtree`，禁加 `attributes`** —— 脚本自身写 data 属性会自我触发。
- **`handleAddedNodes` 先把行收进 Set 去重、批次末尾每行只判定一次** —— 站点分多次插入骨架 / 标题 / 徽章，逐次判定会重复计算。文本节点只提升宿主行、别查后代；不要在容器节点上读 `textContent`（会遍历整棵子树）。
- **类别树就绪前（`ready === false`）不落任何行状态** —— 否则同一行会先按不完整的分类集合算一遍、树到了又跳一次。
  - 注意 `ready` 的**真实条件**：只有「所有等级」规则才依赖类别树，没有这类规则时它一开始就是 `true`。别把它当成"树没到就一律不过滤"。

## 匹配缓存

- **命中与未命中都要缓存**，靠内容指纹（标题 + 类别 ID 集合 + 标签）失效，规则变更靠 `matchVersion` 整批失效，超 4000 条整批丢弃 —— 机制与理由见 [internals.md](internals.md)。

## 流程纪律

- **`@version` 由用户管理，不得改动。**
