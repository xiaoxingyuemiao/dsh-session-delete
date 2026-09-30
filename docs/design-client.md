# 设计说明：Client 半边

本篇记录 Client 半边（`lib/client.js`）的契约依据与三个踩坑点。结论均来自对 DSH 0.2.0-rc.2 随包源码的核对。

## 1. 客户端插件的加载契约

浏览器插件包在 `package.json` 里声明 `dsh.client`（`platform: 'web'`），并通过 `exports["./client"]` 导出一个**预先构建好**的 bundle。宿主把它挂在 `/plugins` 下，组合成 combo 脚本供页面加载。

**bundle 不是 ESM，而是经典脚本**，必须自注册：

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => { /* 返回模块导出 { name, inject, apply } */ },
})
```

要点：

- **`id` 必须等于包名**（也就是宿主行的 `name`）——模块表按这个 key 查找工厂；写错会在启动时报 `bundle loaded without registering "…" via __ModuleLoader__.load`。
- 执行 bundle 只是**注册工厂**，模块体（含 CSS 注入）是**惰性**的，在首次 `require` 或物化时才运行。
- `immediately: true` 让它进入启动必经路径，所以这里的任何异常都会直接导致页面启动失败——改这个文件后务必做契约验证。

## 2. 可用的依赖：平台种子表

外壳在任何插件运行前初始化一张冻结的模块表（`PLATFORM_MODULES`），动态 bundle 的 external 精确针对它解析。实测种子表内容：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis,
@deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

因此：

- `require('@deepseek-ai/dsh-client-ui-primitives')` **可用**（`MenuItemButton` / `Modal` / `Button` / 图标都从这里来），**不要**把它声明成运行时依赖，也不要打包副本；
- `@deepseek-ai/dsh-client-locale` **不在**种子里，所以本插件的文案直接写死，没有走 `ctx.locale` / `t`。

## 3. 插槽契约

| slot | id | order | 作用 |
| --- | --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `dsh-session-delete` | 500 | 会话行「…」菜单里的「删除」项 |
| `shell.overlay` | `dsh-session-delete-dialog` | 500 | 二次确认弹窗 + 结果提示 |

- 官方内置项的顺序是 `pin` 100 / `rename` 200 / `fork` 300 / `archive` 400，所以 500 落在「归档」之后，正好另起一个分组。
- 注册必须用 `slots.inject(name, () => slots.register(...))`：它等待声明出现，声明折叠时移除贡献项，恢复后重新注册。
- 菜单项组件收到的 props 只有 `{ sessionId, displayTitle }` 加槽级钩子 `useMenuOpenState()`（返回 `[open, setOpen]`）。
- `shell.overlay` 是 list 槽、附加式、`replaceRisk: none`，适合放弹窗。

## 4. 三个必须绕开的坑

### 4.1 弹窗不能放在菜单项组件里

`Menu` **只在 `open` 时渲染 children**。菜单项一点「删除」就会 `setMenuOpen(false)`，菜单项组件随即卸载——放在它里面的 `Modal` 会当场消失。

所以分成两处：菜单项只把 `{ sessionId, title }` 写进**模块级状态**，弹窗注册在常驻的 `shell.overlay` 上渲染。

### 4.2 `MenuItemButton` 会丢弃 `className`

它的 props 解构表就是 `{ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }`，**没有** `className`，也没有把 `...rest` 透传到 `<button>`。所以「浅红」不能靠给组件传 class。

做法是**外层包一个带 class 的 `span`**，用后代选择器着色：

```css
.dsh-sd-row button[role="menuitem"]{color:var(--dsw-alias-state-error-secondary,var(--dsw-alias-state-error-primary))}
.dsh-sd-row button[role="menuitem"] > span{color:inherit}
```

- 第一条权重 `(0,1,1)` 高于 `.danger` 的 `(0,1,0)`，无需 `!important`；
- 第二条是必需的：`.itemIcon` 硬写了 `color: var(--dsw-alias-menu-icon)`，不给它 `inherit` 的话**前置图标仍是灰色**；
- 同时保留 `danger` prop，以便沿用官方红色 hover 底色。

关于「浅红」：浅色主题下 `--dsw-alias-state-error-primary` 是 `red-600`，`--dsw-alias-state-error-secondary` 是更浅的 `red-400`；但 **secondary 不在主题的可覆盖 token 目录里**，且它的深色值与 primary 相同。因此必须写 `var(a, var(b))` 回退，且要清楚「更浅」只在浅色主题下有效。

### 4.3 删除后不要刷新页面

侧栏会话列表是 Host 快照驱动的**只读投影**（`sessionController.list` → 客户端 store）。插件只通过 slot 拿到行身份，拿不到列表状态，也没有公开的「移除一行」接口，所以无法真正即时改列表。

可选手段只有「给行打隐藏标记」。这里有两个必须避开的陷阱：

1. **只打一次标记不够**：DSH 侧栏刷新会**重建行元素**，标记随旧节点一起消失，行就重新出现（尽管文件已经删了）。所以要记住已删集合、幂等重标，并用 `MutationObserver` 在 DOM 变动后自愈。
2. **删除后别做整页 `location.reload()`**：刷新会把本地隐藏记录一并清空，而宿主快照此刻可能还没剔除该会话，行就当场复活——这曾经是「删掉又出现」的直接成因。现在完全不做刷新，交给常驻观察器 + 宿主自己收敛。

已删集合用**带过期时间的 `localStorage`** 持久化（24 小时），这样用户手动按 F5 行也不会冒出来；过期保证记录不会永远压着——万一会话日后从回收站恢复，最多 24 小时后它的行就会重新出现。

隐藏的定位依据是会话行当前的 `data-row-key="session:<id>"` 属性，这是本插件唯一依赖的 DOM 约定。

## 5. 与 Host 的通信

静态安装的插件**没有**动态包的 RPC 桥（`harness.handle` / `host.call` 属于 `dsh-cordis-client-runner` 那条动态 lane）。所以 Host 用 `webServer.register` 注册普通 HTTP 路由，客户端用相对路径 `fetch` 直连：

```
POST /dsh-session-delete/api/trash      { sessionId, title?, requireCascade? }
GET  /dsh-session-delete/api/list
POST /dsh-session-delete/api/restore    { trashId }
POST /dsh-session-delete/api/debug      { ...诊断快照 }
POST /dsh-session-delete/api/unhide     { sessionId }
GET  /dsh-session-delete/api/probe?sessionId=…
```

诊断采集（`/debug`）是刻意保留的：这类「删掉又被刷新带回来」的问题只发生在浏览器端，而插件在客户端没有可读的日志通道，把当时的真实 DOM 状态回报落盘是唯一可靠的定位手段。
