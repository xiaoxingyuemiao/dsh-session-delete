# 设计说明：Host 半边

本篇记录 Host 半边（`lib/index.js`）的设计依据——DSH 的会话存储布局、删除为什么是「移动目录」、以及清理边界的取舍。结论均来自对 DSH 0.2.0-rc.2 随包源码的核对。

## 1. DSH 没有会话删除能力

`@deepseek-ai/dsh-session-persistence-jsonl` 的持久化服务（`ctx.sessionPersistence`）完整接口只有：

```
create(header, options?)   -> SessionHandle
open(id, access, options?) -> SessionHandle
flush()                    -> void
stat(id, options?)         -> SessionPersistenceSnapshot | undefined
list(options?)             -> readonly SessionPersistenceSnapshot[]
```

`SessionHandle` 只有 `read / append / flush / close`。**没有任何 delete / remove / unlink**（唯一的 `truncate` 是崩溃尾部修复）。官方 UI 侧同样如此——`ui-workspace` 明确写明「会话可以归档但绝不会被删除」。

因此「删除」只能由插件自己操作文件系统：把会话目录整体移出 `sessions` 根。这也正好带来可恢复性。

## 2. 磁盘布局

每个会话在「可读的项目目录」下拥有一个自己的目录：

```text
<sessions 根>/
  --<规范化 cwd>--/            # 项目目录；cwd 缺失时是 _no-cwd
    <转义后的 sessionId>/      # 会话自有目录
      session.jsonl.zstd       # v0 代际（压缩）
      session.v4.jsonl.zstd    # 当前代际
      session.v4.jsonl         # 未启用压缩时的形态
```

命名规则（与官方后端逐字一致，插件的 `projectKey` / `encodeSegment` 就是它的复刻）：

- **`projectKey(cwd)`**：`\` `/` `:` 三者折叠成**一个** `-`；其他不安全字符转义为 `~XXXX`（四位大写十六进制）；结果包在 `--…--` 里并截断到 251 字符。例：`D:\DSH插件` → `--D-DSH~63D2~4EF6--`。
- **`encodeSegment(id)`**：保留 `[A-Za-z0-9._-]`，其余转义为 `~XXXX`。因为 `:` 等字符都会转义，原始 id 无法造成路径穿越。
- **代际文件名**：`session.jsonl` 是 v0；v1 起带上小写数字段，即 `session.v<N>.jsonl`；压缩追加 `.zstd`。

插件在定位时**优先**用工作区注册表里的 `cwd` 直接算出路径，算不出来（历史会话、cwd 缺失、落到 `_no-cwd`）时**扫描** `sessions` 根下所有项目目录兜底。两条路径都做三重校验：必须落在 `sessions` 根内、目录名必须等于转义后的会话 id、目录内必须真的存在 `session*.jsonl[.zstd]`。

## 3. 会话存活判定：一个必须做的检查

**运行中的会话不能删。** 原因是官方后端的写入模型：

- 写句柄**不持有长期文件流**——每个追加批次都按路径重新 `open(path, "a")`，写完就关；
- Windows 上的写租约是**从路径派生的命名内核信号量**，不是文件锁或文件句柄，官方文档明确写着它「不会阻止目录被移除」。

两者叠加的后果很严重：如果会话正在运行时把它的目录移走，**下一次追加会在原位重建目录树并写入一个没有 header 的日志**——一个会话被撕裂成两个半截文件（回收站里的旧半截 + 原位的无头新半截）。

所以删除前必须检查 `sessionController.list()` 返回的 `SessionSummary.running`；**子树里任何一个在跑就整棵子树拒绝**，避免删掉一半留下指向已删父会话的孤儿子会话。读取花名册失败时，带 `requireCascade` 的请求直接中止。

## 4. 级联：依赖树怎么建

`SessionSummary` 同时带有 `parentSessionId`、`origin`、`running`，一次 `sessionController.list()` 就能拿到全部会话的依赖关系，无需逐个 `stat`。

- 以 `parentSessionId` 为边建 `childrenOf` 映射；
- 从目标会话出发递归收集**全部后代**（任意深度）；递归时**先深入再入列**，因此结果天然是「子排在父之前」——按该顺序逐个删除即先删叶、后删根；
- 用 visited 集合防环形父子引用（防御性：即使数据异常也不会无限递归）。

## 5. 删除时必须清理的四处

只把目录移走是不够的——工作区注册表与投影缓存都还记着这个会话，会留下幽灵行或脏数据：

| 位置 | 为什么必须清理 |
| --- | --- |
| `storages/workspace.json` → `tables.workspaces.<id>.sessionIds` | 侧栏按「工作区成员 ∩ 有摘要」分组；成员不摘会让该会话以 **Ungrouped** 身份重新出现 |
| `storages/workspace.json` → `global.archivedSessionIds` / `global.pinnedSessionIds` | 指向已消失会话的脏 id 会永久残留 |
| `storages/session_projcache/sessions/<id>.json` | 每会话的派生投影文件 |
| `storages/session_projcache.json` → `tables.sessions[<id>]` | 投影根索引条目；只删文件不摘索引会留下孤儿条目 |

写入策略：**同目录临时文件 + `rename`** 原子替换，并用单飞锁把读改写串行化，避免并发把 `workspace.json` 写坏。

**不需要处理的**：会话搜索索引。`dsh-session-query-sqlite` 在每次搜索前都会 `_reconcile()`，按持久化列表把消失的会话行删掉；而且本部署的配置是 `path: ':memory:'` + `openAt: never`，根本没有落盘索引。

## 6. 回收站必须在 `sessions` 根之外

官方后端的会话发现流程是「列出根下**所有**项目目录 → 列出其中的会话目录 → 解析代际」，**不做深度限制**。如果把回收站放在 `sessions` 根内，形如 `sessions/<trash>/<sessionId>/session.jsonl.zstd` 的两层结构**仍会被当成合法会话扫出来**，删除就白做了。

所以回收站放在 `$DSH_HOME/.dsh-session-trash/`——完全在根之外，`list()` / `open()` / 搜索都不会再看到这些会话。

## 7. 恢复：放回原处而不是「随便找个地方」

清单 `trash.json` 记录 `sessionId`、`title`、`originalDir`、`projectDir`、**`workspaceId`**、**`cwd`**、**`archived`**、`movedAt`。

- 恢复时按 `workspaceId` 把会话登记回**它原来所属的工作区**。早期实现退化成「塞进第一个有 `sessionIds` 的工作区」，会把会话错并进别的工作区分组；旧清单没有 `workspaceId` 时按 `cwd` 匹配，两条都匹配不上就**不动任何工作区**（宁可落在 Ungrouped，也不并错）。
- 删除时摘掉了 `archivedSessionIds` 中的记录（不摘会留脏 id），恢复时据此**还原归档状态**，否则一个原本已归档的会话会突然以普通会话身份出现在列表里。
- 恢复前检查原位置是否已被占用，**存在则拒绝，绝不覆盖**。

## 8. 路径安全

- `sessionId` 走白名单校验 `[A-Za-z0-9._~-]`，从入口就杜绝路径注入；
- 所有文件操作前用 `path.relative` 判定**源必须在 `sessions` 根内、目标必须在回收站根内**；
- `trashId` 拒绝 `/`、`\`、`..`；
- 跨卷时回退到「复制 + 删除」，移动失败会**回滚**已建立的回收站目录，保证原会话不受影响。

## 9. 生命周期

`webServer.register()` 返回的注销函数**不会**自动随插件 fiber 清理，必须包在 `ctx.effect(() => webServer.register(...))` 里，否则插件停止或更新后路由会泄漏，下次注册同路径直接报 `duplicate exact route`。本插件所有路由都按此写法注册。
