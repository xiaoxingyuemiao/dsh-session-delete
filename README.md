# DSH 会话删除插件（dsh-session-delete）

给 DSH 加上**真正能删除会话**的能力：会话行「…」菜单里一个**浅红色「删除」**，点击后**弹窗二次确认**，确认后把该会话**连同它的全部子会话**移入**回收站**（可恢复），并从侧栏与搜索里彻底消失。

> 为什么需要它：DSH 官方只提供「归档」——`dsh-client-ui-workspace` 的文档里明确写着 **「没有 Session 删除：会话可以归档但绝不会被删除」**，持久化层也没有任何 delete 接口。想真正清理会话，只能自己补。

安装到 DSH 后，删除是**可逆**的：文件被移入 `$DSH_HOME/.dsh-session-trash/`，字节不变，随时可以原样恢复。

## 效果

- **入口**：侧栏会话行悬停 →「…」菜单 → 最后一个分组里的「删除」（排在官方「归档」之后，带垃圾桶图标）。
- **颜色**：浅红色。取主题的次级错误色，浅色主题下比官方 `danger` 用的红更浅。
- **二次确认**：

  > **确定要删除这个会话吗？**
  > 「会话标题」
  > 该会话下的子会话（子代理）也会被一起删除。 ← 小字
  > 删除后文件将会移入回收站。

  默认聚焦「确认删除」，`Esc` / 点遮罩 / 「取消」都能退出。
- **删除后**：被删会话**立刻**从侧栏消失，提示「已删除会话「xxx」，连同 N 个子会话，已移入回收站」。
- **级联**：该会话下的**全部子会话 / 子代理会话**（可任意深度嵌套）一并删除。

## 安装

DSH 的网页端与桌面端是**两个独立实例**（不同 profile），需要各装一次。

### 网页端

```powershell
dsh plugin --profile web add link:<本目录绝对路径>
# 例如：
dsh plugin --profile web add link:D:\DSH插件\dsh-session-delete
```

### 桌面端（Electron）

桌面端的 profile 由应用**独占管理**，普通 `dsh --profile desktop …` 会被拒绝，必须用桌面端自带的 CLI：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:D:\DSH插件\dsh-session-delete
```

### 装完之后

**必须重启 DSH**。浏览器半边的 bundle 是在**启动时**扫描并进「启动图」的，不重启不会加载（Host 半边的路由会随 profile 热加载，两者节奏不同，容易误判成"没生效"）。

卸载：

```powershell
dsh plugin --profile web remove dsh-session-delete
```

卸载只移除插件；回收站里的会话文件仍在，需要手动恢复或删除。

## 文件说明

| 文件 | 内容 |
| --- | --- |
| `package.json` | 插件包清单：`dsh.client`（platform `web`）+ `dsh.bundle.patch` + `exports["./client"]` |
| `cordis.patch.yml` | 挂载声明：把插件行插入 profile 的组合树 |
| `lib/index.js` | Host 半边：定位会话目录、移入回收站、清理工作区与缓存、注册 HTTP 路由 |
| `lib/client.js` | Client 半边：菜单项 + 二次确认弹窗 + 即时隐藏（预构建 classic script） |
| `scripts/check.mjs` | 隔离验证：在临时 `DSH_HOME` 上跑完整的删除 / 恢复流程 |
| `docs/` | 开发期的机制侦察记录（设计依据，非运行时文件） |

## 功能细节

### 删除

- **级联子会话**：读取全部会话的 `parentSessionId` 建依赖树，递归收集目标会话的**全部后代**（任意深度），**先叶后根**逐个删除——先删子再删父，中途失败也不会留下指向已删父会话的孤儿。遍历带 visited 集合，可抵御环形父子引用。
- **四处清理**（缺任何一处都会留下幽灵行或脏数据，每个被删会话都要做一遍）：
  1. 会话目录 → `$DSH_HOME/.dsh-session-trash/<trashId>/session`（同卷 `rename` 原子移动，跨卷回退到复制 + 删除）；
  2. `storages/workspace.json` → 从工作区 `sessionIds`、`global.pinnedSessionIds`、`global.archivedSessionIds` 三处摘除；
  3. `storages/session_projcache/sessions/<id>.json` → 删除；
  4. `storages/session_projcache.json` → 删除 `tables.sessions[<id>]` 条目。
- **就地消失**：会话行打上隐藏标记立即从侧栏消失，并由常驻的 `MutationObserver` 在 DSH 重新渲染后自动补标记，不会"复活"。
- 会话搜索索引不需要干预：`dsh-session-query-sqlite` 每次搜索前都会对账，自行删除消失的会话行。

### 回收站与恢复

每个被删会话在回收站里是**独立一条记录**，清单 `trash.json` 记下了原始路径、所属工作区、删除前的归档状态。

```powershell
# 查看回收站
Invoke-RestMethod http://127.0.0.1:<port>/dsh-session-delete/api/list

# 恢复（一次一个）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/dsh-session-delete/api/restore `
  -ContentType 'application/json' -Body '{"trashId":"<列表里的 trashId>"}'
```

恢复会把会话**放回它原来所属的那个工作区**（不是随便挑一个），并还原删除前的归档状态。也可以纯手工恢复：把 `.dsh-session-trash/<trashId>/session` 整个目录移回清单里的 `originalDir` 即可，会话日志字节全程未被改动。

### 诊断

「删掉后行又出现」有两种完全不同的成因——文件没删干净，或者文件删了但前端列表快照没收敛。`probe` 一次把三条独立事实都摊开：

```powershell
Invoke-RestMethod 'http://127.0.0.1:<port>/dsh-session-delete/api/probe?sessionId=<会话id>'
```

| 字段 | 含义 |
| --- | --- |
| `onDisk` | 会话目录是否还在 `sessions` 根下（真实删除结果） |
| `inHostList` | 宿主自己的会话列表是否还把它算在内（侧栏渲染的来源） |
| `inTrash` | 回收站里有没有它 |

典型的「删成功但行还在」会表现为 `onDisk=false` / `inTrash=true` / `inHostList=true`，说明问题在宿主的列表快照收敛，不在删除本身。

删除成功后浏览器半边还会在 0 / 0.8 / 2.5 / 6 秒四个时间点采样 DOM（隐藏标记是否还在、`display` 实际值、页面上全部行键），回报落盘到 `$DSH_HOME/.dsh-session-delete-debug.jsonl`，用于复现「行被刷新带回来」这类问题。

## 安全边界

| 场景 | 行为 |
| --- | --- |
| 会话**正在运行** | **拒绝删除**，提示先停止。理由：会话日志的写句柄不持有长期文件流，每次追加都按路径重新 `open(path,"a")`；Windows 上写租约是命名信号量而非文件锁，**挡不住目录被移走**，下一次追加会在原位重建一个**没有 header 的日志**，把会话撕裂成两个半截文件。 |
| **子树里有会话在运行** | **整棵子树一并拒绝**，并报告有几个在跑。不做部分删除。 |
| 算不出子会话（花名册读不到） | **中止**，不静默地只删父会话。 |
| 某个后代删除失败 | 其余继续；返回 `partial: true` 与 `failed[]`，前端提示「已删除 N 个，其余失败」。 |
| `sessionId` 含路径分隔符或 `..` | 拒绝（白名单 `[A-Za-z0-9._~-]`）。 |
| 会话目录不在 `sessions` 根内 | 拒绝，绝不越界操作。 |
| 原位置已被占用时恢复 | 拒绝，**不覆盖**。 |
| 移动失败（跨卷复制出错等） | 回滚回收站目录，原会话保持原样。 |
| 清理注册表 / 缓存失败 | 不回滚删除（会话文件已安全移走），记录在返回值的 `cleanup` 里。 |

**回收站必须放在 `sessions` 根之外**：DSH 会把 `sessions` 根下**每一层目录**都当成项目目录，如果回收站放在里面，被删的会话仍会被当成合法会话扫出来。放在 `$DSH_HOME/.dsh-session-trash/` 才能真正从列表、打开和搜索里消失。

## 工作原理

1. **Host 半边**注册三个业务路由与两个诊断路由（`webServer.register`，包在 `ctx.effect` 内以便随插件生命周期注销）。静态安装的插件没有动态包的 RPC 桥，因此客户端直接用 `fetch` 调这些相对路径。
2. **会话目录定位**复刻 `dsh-session-persistence-jsonl` 的路径规则：`$DSH_HOME/sessions/--<规范化 cwd>--/<转义后的 sessionId>/`。`cwd` 里的 `\` `/` `:` 折叠成一个 `-`，其他不安全字符转义为 `~XXXX`（如 `D:\DSH插件` → `--D-DSH~63D2~4EF6--`）；会话 id 同样单射转义。优先用工作区注册表里的 `cwd` 直接算出路径，算不出来时扫描 `sessions` 根兜底；两条路径都强制校验（必须在根内、目录名必须等于转义后的 id、目录内必须真有会话日志）。
3. **注册表写入**用「临时文件 + rename」原子替换，并用单飞锁串行化，避免并发读改写把 `workspace.json` 写坏。
4. **Client 半边**通过 `window.__ModuleLoader__.load({ id, factory })` 注册（id 必须等于包名），占用两个 slot：`sidebar.workspaces.session.menu.item`（菜单项，order 500）与 `shell.overlay`（确认弹窗）。依赖走平台种子表（`react`、`@deepseek-ai/dsh-client-ui-primitives` 等），不需要声明运行时依赖，也不要打包副本。

## 开发与验证

```powershell
cd dsh-session-delete
node scripts/check.mjs
```

脚本在**临时目录**里造一套假 `DSH_HOME`，跑真实的「删除 → 清理 → 恢复」全流程，共 **40 项断言**，覆盖路径编码规则、两种目录定位路径、四处清理的精确性（并确认无关会话完全不受影响）、字节完整性、恢复回原工作区与原归档状态、级联依赖树（含环形引用防御）、以及一组前端防回归断言（隐藏标记与自愈、隐藏记录持久化、**断言删除流程里不出现整页 `reload`**、**断言观察器不常驻断开**）。

## 已知限制

- **正在运行的会话删不掉**（见上表），需要先停止。
- 回收站**没有自动清理**：恢复要手动调用接口或手工移动目录；不需要的可以自行删除 `.dsh-session-trash/` 下的目录。
- 级联删除在回收站里是**多条独立记录**，恢复需要逐个进行。
- 删除**不会**清理会话引用的图片 / 文件附件（附件按内容寻址，可能被其他会话共用）。
- 前端的即时隐藏依赖会话行当前的 `data-row-key="session:<id>"` 属性；DSH 若改变该 DOM 约定，需要同步调整选择器（`node scripts/check.mjs` 有对应断言）。

## 许可

MIT
