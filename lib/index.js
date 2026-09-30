// dsh-session-delete —— Host 半边
//
// 运行环境：DSH 主进程（完整 Node ESM）。
// 职责：为浏览器半边（lib/client.js）提供 HTTP API：
//   POST /dsh-session-delete/api/trash   { sessionId, title? } -> 移入回收站
//   GET  /dsh-session-delete/api/list    -> 回收站内容
//   POST /dsh-session-delete/api/restore { trashId } -> 从回收站恢复
//
// 设计要点：
// 1. DSH 官方只提供「归档」，没有会话删除接口，因此删除 = 把会话目录整体移出
//    sessions 根目录，落到 $DSH_HOME/.dsh-session-trash/<trashId>/session 下。
//    这是可逆操作：移回原路径即可完整恢复（jsonl 字节未被改动）。
// 2. 只移动会话目录本身；attachments 等共享数据不动（它们按内容寻址，可能被其他会话引用）。
// 3. 同步清理工作区注册表里的成员/置顶/归档记录与投影缓存，否则侧栏会留下指向
//    已消失会话的「幽灵行」。搜索索引无需处理：它自带对账，会自行删除消失的会话行。
//
// 目录命名规则与 @deepseek-ai/dsh-session-persistence-jsonl 保持一致：
//   sessions/--<规范化 cwd>--/<转义后的 sessionId>/session.vN.jsonl.zstd
//   cwd 中的路径分隔符与冒号折叠为 '-'，其他不安全字符转义为 ~XXXX（大写十六进制）。
// 见 dsh-session-persistence-jsonl/lib/index.js 的 projectKey() / encodeSegment()。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const name = 'dsh-session-delete'

/** 本插件只依赖 webServer 提供路由；其余能力按需软获取。 */
const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-session-delete/api'

const env = process.env
const DSH_HOME = env.DSH_HOME && env.DSH_HOME.trim() !== ''
  ? env.DSH_HOME
  : path.join(os.homedir(), '.dsh')

/**
 * 由 DSH_HOME 派生全部存储位置。
 *
 * 之所以做成工厂而不是模块级常量：验证脚本要在临时目录上跑真实的删除/恢复流程，
 * 绝不能碰用户自己的会话。生产路径始终使用真实的 DSH_HOME。
 *
 * @param {string} dshHome DSH 主目录。
 */
function createPaths(dshHome) {
  return {
    dshHome,
    sessionsRoot: path.join(dshHome, 'sessions'),
    trashRoot: path.join(dshHome, '.dsh-session-trash'),
    workspaceStore: path.join(dshHome, 'storages', 'workspace.json'),
    projcacheRootStore: path.join(dshHome, 'storages', 'session_projcache.json'),
    projcacheSessions: path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
  }
}

/** 当前生效的路径集合；createEngine() 只会在测试时替换它。 */
let P = createPaths(DSH_HOME)

/** apply() 收到的 Cordis 上下文；用于按需软获取 sessionController。 */
let activeCtx

/** 会话控制器服务的缓存（未挂载时为 null）。 */
let sessionControllerRef

const MAX_BODY = 64 * 1024
const MANIFEST_NAME = 'trash.json'

// ───────────────────────────── 通用工具 ─────────────────────────────

function errText(err) {
  try {
    if (err && typeof err.message === 'string' && err.message !== '') return String(err.message)
    return String(err)
  } catch {
    return '未知错误'
  }
}

function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.byteLength),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 单飞串行化：注册表的读改写不能并发交错。 */
let storeChain = Promise.resolve()
function withStoreLock(operation) {
  const run = storeChain.then(operation, operation)
  storeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ─────────────────── 磁盘布局：与官方 jsonl 后端同规则 ───────────────────

/**
 * 会话 id → 单个安全路径段。与 dsh-session-persistence-jsonl 的 encodeSegment 完全一致。
 * @param {string} raw 原始会话 id。
 * @returns {string} 转义后的路径段。
 */
function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('空的会话 id')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * cwd → 可读的项目目录名。与 dsh-session-persistence-jsonl 的 projectKey 完全一致。
 * @param {string} cwd 会话的项目目录。
 * @returns {string} 形如 `--D-DSH--` 的目录名。
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('空的项目路径')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 会话目录内的日志文件名（当前代际为 session.vN.jsonl[.zstd]）。 */
function isSessionLogName(fileName) {
  return /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(fileName)
}

/** child 是否位于 parent 之内（含 parent 自身）。用于阻止任何越界路径操作。 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 判断 dir 是否为「该会话自己的目录」：目录名等于转义 id，且里面确有会话日志。 */
function looksLikeSessionDir(dir, encodedId) {
  if (path.basename(dir) !== encodedId) return false
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  return entries.some(isSessionLogName)
}

/**
 * 定位一个会话在磁盘上的目录。
 *
 * 优先用「工作区注册表里的 cwd + 官方转义规则」直接算出路径；算不出来（历史会话、
 * cwd 缺失、路径规则变化）时退化为扫描 sessions 根下所有项目目录。两条路径都做
 * 严格校验：必须落在 sessions 根内、目录名必须等于转义后的会话 id、目录内必须有会话日志。
 *
 * @param {string} sessionId 会话 id。
 * @returns {{ dir: string, projectDir: string } | null}
 */
function locateSessionDir(sessionId) {
  let encodedId
  try {
    encodedId = encodeSegment(sessionId)
  } catch {
    return null
  }
  if (!fs.existsSync(P.sessionsRoot)) return null

  // 方案 A：由工作区注册表拿到 cwd，直接拼出预期路径。
  const known = workspaceCwdOf(sessionId)
  if (known !== null) {
    const projectDir = path.join(P.sessionsRoot, projectKey(known))
    const dir = path.join(projectDir, encodedId)
    if (isInside(P.sessionsRoot, dir) && looksLikeSessionDir(dir, encodedId)) {
      return { dir, projectDir }
    }
  }

  // 方案 B：扫描所有项目目录（覆盖 cwd 未知、以及落到 _no-cwd 的会话）。
  let projects
  try {
    projects = fs.readdirSync(P.sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(P.sessionsRoot, entry.name)
    const dir = path.join(projectDir, encodedId)
    if (isInside(P.sessionsRoot, dir) && looksLikeSessionDir(dir, encodedId)) {
      return { dir, projectDir }
    }
  }
  return null
}

// ───────────────────────── 工作区注册表（workspace.json） ─────────────────────────

function readWorkspaceStore() {
  try {
    if (!fs.existsSync(P.workspaceStore)) return null
    const parsed = JSON.parse(fs.readFileSync(P.workspaceStore, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从工作区注册表反查某会话所属的工作区（id + cwd）。 */
function workspaceOf(sessionId) {
  const store = readWorkspaceStore()
  const workspaces = store?.tables?.workspaces
  if (workspaces === undefined || workspaces === null || typeof workspaces !== 'object') return null
  for (const [id, workspace] of Object.entries(workspaces)) {
    const ids = workspace?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    return {
      id,
      cwd: typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : null,
    }
  }
  return null
}

/** 只关心 cwd 时的便捷封装。 */
function workspaceCwdOf(sessionId) {
  return workspaceOf(sessionId)?.cwd ?? null
}

/** 该会话删除前是否处于「已归档」状态。恢复时据此还原，避免它悄悄变回普通会话。 */
function wasArchived(sessionId) {
  const store = readWorkspaceStore()
  const list = store?.global?.archivedSessionIds
  return Array.isArray(list) && list.includes(sessionId)
}

/**
 * 摘掉会话在工作区注册表里的全部痕迹：成员、置顶、归档。
 * 不清理会让侧栏留下指向已消失会话的幽灵行，置顶/归档集合也会永久残留。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{ changed: boolean, removedFrom: string[] }>}
 */
async function pruneWorkspaceStore(sessionId) {
  return withStoreLock(async () => {
    const store = readWorkspaceStore()
    if (store === null) return { changed: false, removedFrom: [] }

    const removedFrom = []
    let changed = false

    const dropFromArray = (owner, key, label) => {
      const list = owner?.[key]
      if (!Array.isArray(list)) return
      const next = list.filter((id) => id !== sessionId)
      if (next.length !== list.length) {
        owner[key] = next
        changed = true
        removedFrom.push(label)
      }
    }

    dropFromArray(store.global, 'archivedSessionIds', 'archived')
    dropFromArray(store.global, 'pinnedSessionIds', 'pinned')

    const workspaces = store.tables?.workspaces
    if (workspaces !== null && typeof workspaces === 'object') {
      for (const workspace of Object.values(workspaces)) {
        dropFromArray(workspace, 'sessionIds', 'workspace')
      }
    }

    if (!changed) return { changed: false, removedFrom: [] }

    // 原子写：同目录临时文件 + rename，避免半截 JSON 破坏注册表。
    const tmp = `${P.workspaceStore}.dsh-session-delete.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, P.workspaceStore)
    return { changed: true, removedFrom }
  })
}

/**
 * 把会话重新登记回**它原来所属的**工作区（恢复时尽力而为；失败不影响文件恢复）。
 *
 * 必须按 workspaceId 精确定位：早先的实现退化为「塞进第一个有 sessionIds 的工作区」，
 * 会把会话错误地并进别的工作区分组里。没有记录 workspaceId 时（旧清单）退回按 cwd 匹配。
 *
 * @param {string} sessionId 会话 id。
 * @param {string|null|undefined} workspaceId 删除时记录的工作区 id。
 * @param {string|null|undefined} cwd 删除时记录的项目目录，用于兜底匹配。
 */
async function restoreWorkspaceStore(sessionId, workspaceId, cwd) {
  return withStoreLock(async () => {
    const store = readWorkspaceStore()
    if (store === null) return { changed: false }
    const workspaces = store.tables?.workspaces
    if (workspaces === null || typeof workspaces !== 'object') return { changed: false }

    let workspace = workspaceId !== undefined && workspaceId !== null && workspaceId !== ''
      ? workspaces[workspaceId]
      : undefined
    let matchedBy = workspace === undefined ? null : 'workspaceId'

    if (workspace === undefined && typeof cwd === 'string' && cwd !== '') {
      // 旧清单没有 workspaceId 时，按项目目录匹配，仍比「随便挑一个」准确。
      const hit = Object.entries(workspaces)
        .find(([, candidate]) => candidate?.path === cwd)
      if (hit !== undefined) {
        workspace = hit[1]
        matchedBy = 'cwd'
      }
    }

    // 两条路都匹配不上：不动任何工作区，只把会话文件放回去（宁可落在 Ungrouped）。
    if (workspace === undefined || workspace === null) {
      return { changed: false, matchedBy: null }
    }
    if (!Array.isArray(workspace.sessionIds)) workspace.sessionIds = []
    if (workspace.sessionIds.includes(sessionId)) return { changed: false, matchedBy }
    workspace.sessionIds.unshift(sessionId)
    const tmp = `${P.workspaceStore}.dsh-session-delete.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, P.workspaceStore)
    return { changed: true, matchedBy }
  })
}

// ───────────────────────── 投影缓存清理 ─────────────────────────

/**
 * 把会话还原回「已归档」状态。
 *
 * 删除时把 archivedSessionIds 里的记录摘掉了（不摘会留下指向已消失会话的脏 id），
 * 所以恢复时必须补回来，否则一个原本已归档的会话会突然以普通会话身份出现在列表里。
 *
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{ changed: boolean }>}
 */
async function restoreArchivedFlag(sessionId) {
  return withStoreLock(async () => {
    const store = readWorkspaceStore()
    if (store === null) return { changed: false }
    const global = store.global
    if (global === null || typeof global !== 'object') return { changed: false }
    if (!Array.isArray(global.archivedSessionIds)) global.archivedSessionIds = []
    if (global.archivedSessionIds.includes(sessionId)) return { changed: false }
    global.archivedSessionIds.push(sessionId)
    const tmp = `${P.workspaceStore}.dsh-session-delete.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, P.workspaceStore)
    return { changed: true }
  })
}

/**
 * 清理该会话的投影缓存。
 *
 * 两类位置都要清：
 *   1. `storages/session_projcache/sessions/<id>.json` —— 每会话的派生投影文件；
 *   2. `storages/session_projcache.json` 的 `tables.sessions[<id>]` —— 根索引里的条目。
 * 两者都是纯派生数据（可从会话日志重算），但只清文件不摘根索引会留下孤儿条目。
 * 会话搜索索引不需要本插件干预：dsh-session-query-sqlite 自带对账，
 * 会依据持久化列表自行删除消失的会话行。
 *
 * @param {string} sessionId 会话 id。
 * @returns {number} 实际清理掉的位置数量。
 */
function pruneProjectionCache(sessionId) {
  let removed = 0

  // 1) 每会话投影文件
  const candidates = [
    path.join(P.projcacheSessions, `${sessionId}.json`),
    path.join(P.projcacheSessions, `${encodeSegment(sessionId)}.json`),
  ]
  for (const file of candidates) {
    if (!isInside(P.projcacheSessions, file)) continue
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    } catch {
      /* 缓存清理失败不影响删除结果 */
    }
  }

  // 2) 根索引条目
  try {
    if (fs.existsSync(P.projcacheRootStore)) {
      const store = JSON.parse(fs.readFileSync(P.projcacheRootStore, 'utf8'))
      const sessions = store?.tables?.sessions
      if (sessions !== null && typeof sessions === 'object'
        && Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
        delete sessions[sessionId]
        const tmp = `${P.projcacheRootStore}.dsh-session-delete.tmp`
        fs.writeFileSync(tmp, `${JSON.stringify(store)}\n`, 'utf8')
        fs.renameSync(tmp, P.projcacheRootStore)
        removed += 1
      }
    }
  } catch {
    /* 根索引损坏或写入失败时忽略：它是派生数据，宿主会重算 */
  }

  return removed
}

// ───────────────────────── 回收站 ─────────────────────────

function trashIdFor(sessionId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stamp}__${encodeSegment(sessionId)}__${suffix}`
}

function readManifest(trashId) {
  const file = path.join(P.trashRoot, trashId, MANIFEST_NAME)
  if (!isInside(P.trashRoot, file)) return null
  try {
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function directorySize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 忽略不可读文件 */
        }
      }
    }
  }
  return total
}

function listTrash() {
  if (!fs.existsSync(P.trashRoot)) return []
  const rows = []
  for (const entry of fs.readdirSync(P.trashRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = readManifest(entry.name)
    rows.push({
      trashId: entry.name,
      sessionId: manifest?.sessionId ?? null,
      title: manifest?.title ?? null,
      movedAt: manifest?.movedAt ?? null,
      originalDir: manifest?.originalDir ?? null,
      bytes: directorySize(path.join(P.trashRoot, entry.name, 'session')),
    })
  }
  rows.sort((a, b) => String(b.movedAt ?? '').localeCompare(String(a.movedAt ?? '')))
  return rows
}

// ───────────────────────── 会话存活判定与依赖关系 ─────────────────────────

/**
 * 读取会话花名册：所有会话的 id、父会话、来源与运行状态。
 *
 * 一次 `sessionController.list` 就能拿到全部信息，既用于「运行中」判定，
 * 也用于计算子会话依赖树。失败时返回 undefined，调用方据此降级处理。
 *
 * @returns {Promise<Array<{ sessionId: string, parentSessionId: string | null, origin: string | null, running: boolean }> | undefined>}
 */
async function readRoster() {
  const controller = getSessionController()
  if (controller === undefined) return undefined
  try {
    // SessionController.list(request, signal)。signal 允许缺省，因此先按官方签名调用，
    // 失败再退化为无参调用，避免不同 dsh 版本的入参校验差异把结果误判。
    let value
    try {
      value = await controller.list({}, undefined)
    } catch {
      value = await controller.list()
    }
    const items = Array.isArray(value?.items) ? value.items : []
    return items
      .map((item) => ({
        sessionId: typeof item?.sessionId === 'string' ? item.sessionId : '',
        parentSessionId: typeof item?.parentSessionId === 'string' ? item.parentSessionId : null,
        origin: typeof item?.origin === 'string' ? item.origin : null,
        running: item?.running === true,
      }))
      .filter((row) => row.sessionId !== '')
  } catch {
    return undefined
  }
}

/**
 * 找出某会话的全部后代会话（子会话，以及子会话的子会话，可任意深度）。
 *
 * 依赖 `SessionSummary.parentSessionId`。返回顺序保证「子永远排在父之前」，
 * 因此按返回顺序逐个删除即可先删叶后删根。
 *
 * @param {Array<object>} roster 花名册。
 * @param {string} rootId 根会话 id。
 * @returns {Array<object>} 后代列表（不含根）。
 */
function collectDescendants(roster, rootId) {
  const childrenOf = new Map()
  for (const row of roster) {
    if (row.parentSessionId === null) continue
    const bucket = childrenOf.get(row.parentSessionId)
    if (bucket === undefined) childrenOf.set(row.parentSessionId, [row])
    else bucket.push(row)
  }

  const out = []
  const seen = new Set([rootId])
  const walk = (parentId) => {
    for (const child of childrenOf.get(parentId) ?? []) {
      if (seen.has(child.sessionId)) continue // 防御环形父子引用
      seen.add(child.sessionId)
      walk(child.sessionId) // 先深入更深层，保证 out 里子排在父之前
      out.push(child)
    }
  }
  walk(rootId)
  return out
}

/** 取会话控制器服务（可能未挂载）。 */
function getSessionController() {
  if (sessionControllerRef === undefined) {
    try {
      sessionControllerRef = activeCtx === undefined ? undefined : activeCtx.get('sessionController')
    } catch {
      sessionControllerRef = undefined
    }
  }
  return sessionControllerRef ?? undefined
}

// ───────────────────────── 删除 / 恢复 主流程 ─────────────────────────

/**
 * 把一个会话移入回收站。
 * @param {{ sessionId: string, title?: string|null }} input 请求体。
 * @returns {Promise<object>} 结果视图。
 */
async function trashSession(input) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : ''
  if (sessionId === '') return { ok: false, error: '缺少 sessionId' }
  // 会话 id 只允许安全字符，杜绝任何形式的路径注入。
  if (!/^[A-Za-z0-9._~-]+$/.test(sessionId)) return { ok: false, error: 'sessionId 含非法字符' }

  const roster = await readRoster()

  // 计算要一起删除的会话集合：目标本身 + 它的全部后代会话。
  const descendants = roster === undefined ? [] : collectDescendants(roster, sessionId)
  const cascadeUnavailable = roster === undefined && input?.requireCascade === true
  if (cascadeUnavailable) {
    return { ok: false, code: 'cascade-unavailable', error: '无法读取会话列表，已中止以免漏删子会话' }
  }

  // 运行中的会话必须先停止：否则其下一次 append 会在原位重建一个无 header 的日志，
  // 把会话撕裂成两个半截文件。整棵子树里任何一个在跑都拒绝，避免删掉一半。
  if (roster !== undefined) {
    const byId = new Map(roster.map((row) => [row.sessionId, row]))
    const self = byId.get(sessionId)
    const blocked = []
    if (self?.running === true) blocked.push({ sessionId, title: null })
    for (const row of descendants) {
      if (row.running === true) blocked.push({ sessionId: row.sessionId, title: null })
    }
    if (blocked.length > 0) {
      return {
        ok: false,
        code: 'running',
        error: blocked.length === 1 && blocked[0].sessionId === sessionId
          ? '该会话仍有正在进行的回合，请先停止后再删除。'
          : `该会话下还有 ${blocked.length} 个正在运行的会话（含子会话），请先全部停止后再删除。`,
        blocked,
      }
    }
  }

  // 删除顺序：先叶后根（collectDescendants 已保证），最后删目标本身。
  const order = [...descendants.map((row) => row.sessionId), sessionId]
  const removed = []
  const failed = []
  for (const id of order) {
    const result = await trashOne(id, id === sessionId ? input?.title : null)
    if (result.ok === true) {
      removed.push({
        sessionId: id,
        title: result.title,
        trashId: result.trashId,
        // 逐会话的清理详情：workspace.json 是否真的改过、投影缓存清掉几处。
        // 放在返回值里，便于调用方核对「删干净了没有」。
        cleanup: result.cleanup,
        isRoot: id === sessionId,
        origin: roster === undefined
          ? null
          : (roster.find((row) => row.sessionId === id)?.origin ?? null),
      })
    } else {
      failed.push({ sessionId: id, code: result.code ?? null, error: result.error })
    }
  }

  if (removed.length === 0) {
    const first = failed[0]
    return { ok: false, code: first?.code ?? 'failed', error: first?.error ?? '删除失败', failed }
  }

  return {
    ok: true,
    sessionId,
    title: removed.find((row) => row.isRoot === true)?.title ?? null,
    removed,
    removedIds: removed.map((row) => row.sessionId),
    removedCount: removed.length,
    descendantCount: removed.filter((row) => row.isRoot !== true).length,
    ...(failed.length > 0 ? { partial: true, failed } : {}),
    hint: '会话已移入回收站，可调用 restore 接口恢复。',
  }
}

/**
 * 把**一个**会话目录移入回收站，并清理它的注册表与缓存痕迹。
 *
 * 不做运行中判定、不做级联——那些由 trashSession 统一决策，避免逐个重复读花名册。
 *
 * @param {string} sessionId 会话 id（已通过字符白名单校验）。
 * @param {string|null|undefined} title 显示标题，仅用于回收站清单。
 * @returns {Promise<object>} 结果视图。
 */
async function trashOne(sessionId, title) {
  const located = locateSessionDir(sessionId)
  if (located === null) {
    return { ok: false, code: 'not-found', error: '找不到该会话的磁盘目录，可能已被删除' }
  }

  const trashId = trashIdFor(sessionId)
  const trashDir = path.join(P.trashRoot, trashId)
  const dest = path.join(trashDir, 'session')

  // 越界防线：源必须在 sessions 根内，目标必须在回收站根内。
  if (!isInside(P.sessionsRoot, located.dir) || !isInside(P.trashRoot, dest)) {
    return { ok: false, error: '拒绝越界的路径操作' }
  }

  await fsp.mkdir(trashDir, { recursive: true })

  const manifest = {
    version: 1,
    sessionId,
    title: typeof title === 'string' && title !== '' ? title : null,
    // 记下所属工作区，恢复时才能放回**原来那个**工作区，而不是随便挑一个。
    workspaceId: workspaceOf(sessionId)?.id ?? null,
    cwd: workspaceCwdOf(sessionId),
    archived: wasArchived(sessionId),
    originalDir: located.dir,
    projectDir: located.projectDir,
    movedAt: new Date().toISOString(),
  }

  try {
    try {
      // 同卷：原子改名，最快且不留中间态。
      await fsp.rename(located.dir, dest)
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err
      // 跨卷：复制后删除。
      await fsp.cp(located.dir, dest, { recursive: true, preserveTimestamps: true })
      await fsp.rm(located.dir, { recursive: true, force: true })
    }
    await fsp.writeFile(path.join(trashDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch (err) {
    // 移动失败：回滚已建立的回收站目录，保持原会话不受影响。
    try {
      await fsp.rm(trashDir, { recursive: true, force: true })
    } catch {
      /* 尽力回滚 */
    }
    return { ok: false, error: `移入回收站失败：${errText(err)}` }
  }

  // 会话目录已经安全移走，后续清理都是尽力而为，任何失败都不回滚删除。
  const cleanup = { workspace: null, projectionCache: 0 }
  try {
    cleanup.workspace = await pruneWorkspaceStore(sessionId)
  } catch (err) {
    cleanup.workspace = { changed: false, error: errText(err) }
  }
  try {
    cleanup.projectionCache = pruneProjectionCache(sessionId)
  } catch {
    cleanup.projectionCache = 0
  }

  return {
    ok: true,
    sessionId,
    title: manifest.title,
    trashId,
    trashDir,
    originalDir: located.dir,
    cleanup,
  }
}

/**
 * 从回收站恢复一个会话。
 * @param {{ trashId: string }} input 请求体。
 * @returns {Promise<object>} 结果视图。
 */
async function restoreSession(input) {
  const trashId = typeof input?.trashId === 'string' ? input.trashId.trim() : ''
  if (trashId === '' || trashId.includes('/') || trashId.includes('\\') || trashId.includes('..')) {
    return { ok: false, error: 'trashId 非法' }
  }
  const manifest = readManifest(trashId)
  if (manifest === null) return { ok: false, error: '回收站里找不到该记录' }

  const source = path.join(P.trashRoot, trashId, 'session')
  const target = typeof manifest.originalDir === 'string' ? manifest.originalDir : null
  if (target === null || !isInside(P.sessionsRoot, target)) {
    return { ok: false, error: '记录的原始路径非法，拒绝恢复' }
  }
  if (!fs.existsSync(source)) return { ok: false, error: '回收站内的会话文件已丢失' }
  if (fs.existsSync(target)) return { ok: false, error: '原位置已被占用，请先处理后再恢复' }

  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    try {
      await fsp.rename(source, target)
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err
      await fsp.cp(source, target, { recursive: true, preserveTimestamps: true })
      await fsp.rm(source, { recursive: true, force: true })
    }
    await fsp.rm(path.join(P.trashRoot, trashId), { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `恢复失败：${errText(err)}` }
  }

  let workspace = null
  try {
    workspace = await restoreWorkspaceStore(manifest.sessionId, manifest.workspaceId, manifest.cwd)
  } catch (err) {
    workspace = { changed: false, error: errText(err) }
  }

  // 删除前是「已归档」的，恢复后也还原成已归档；否则会悄悄变成一个普通会话跑进列表。
  let archived = null
  if (manifest.archived === true) {
    try {
      archived = await restoreArchivedFlag(manifest.sessionId)
    } catch (err) {
      archived = { changed: false, error: errText(err) }
    }
  }

  return { ok: true, sessionId: manifest.sessionId, restoredTo: target, workspace, archived }
}

/**
 * 探测一个会话在**宿主自己眼里**是否还存在。
 *
 * 「删掉后行又出现」的关键分歧点是：宿主刷新列表时到底还把不把这个会话算在里面。
 * 文件已删 ≠ 宿主快照已更新，而这个快照正是侧栏渲染的来源。
 * 因此这里同时报告三条独立事实：文件是否还在磁盘、宿主的 list() 是否还列出它、回收站里有没有它。
 *
 * @param {string} sessionId 会话 id。
 * @returns {Promise<object>} 探测结果。
 */
async function probeSession(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(sessionId)) {
    return { ok: false, error: 'sessionId 非法' }
  }

  const located = locateSessionDir(sessionId)

  const roster = await readRoster()
  const inHostList = roster === undefined
    ? null
    : roster.some((row) => row.sessionId === sessionId)

  let inTrash = null
  try {
    inTrash = listTrash().some((row) => row.sessionId === sessionId)
  } catch {
    inTrash = null
  }

  return {
    ok: true,
    sessionId,
    onDisk: located !== null,
    onDiskDir: located === null ? null : located.dir,
    inHostList,
    hostListReadable: roster !== undefined,
    hostListSize: roster === undefined ? null : roster.length,
    inTrash,
  }
}

// ───────────────────────── 诊断 ─────────────────────────

/**
 * 记录一条来自浏览器半边的诊断报告，落盘到 `$DSH_HOME/.dsh-session-delete-debug.jsonl`。
 *
 * 为什么需要它：会话行「删掉又被宿主刷新带回来」这类问题只发生在浏览器端，
 * 而插件在客户端没有可读的日志通道。把这个接口留着，复现时就能拿到当时的真实
 * DOM 结构（行元素、data-row-key、隐藏标记、宿主接口返回），不必靠猜。
 *
 * @param {object} report 浏览器端采集的报告。
 * @returns {Promise<object>} 写入结果。
 */
async function recordDebug(report) {
  const file = path.join(P.dshHome, '.dsh-session-delete-debug.jsonl')
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...(report !== null && typeof report === 'object' ? report : { raw: report }),
  })
  try {
    await fsp.appendFile(file, `${line}\n`, 'utf8')
    return { ok: true, file }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

// ───────────────────────── HTTP 路由 ─────────────────────────

function registerRoute(webServer, routePath, handler) {
  return webServer.register({ kind: 'exact', path: routePath, handler })
}

function apply(ctx) {
  activeCtx = ctx
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) return

  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/trash`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '仅支持 POST' }, 405)
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      sendJson(res, await trashSession(body))
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))

  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/list`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: '仅支持 GET' }, 405)
      return
    }
    try {
      sendJson(res, { ok: true, trashRoot: P.trashRoot, items: listTrash() })
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))

  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/restore`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '仅支持 POST' }, 405)
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      sendJson(res, await restoreSession(body))
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))

  // 诊断通道：浏览器半边把「删除后的真实 DOM 状态」回报到这里落盘。
  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/debug`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '仅支持 POST' }, 405)
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      sendJson(res, await recordDebug(body))
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))

  // 会话在浏览器半边被本地隐藏过；恢复它时要能主动解除，否则行会被本地记录压着。
  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/unhide`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: '仅支持 POST' }, 405)
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [body?.sessionId]
      sendJson(res, { ok: true, sessionIds: ids.filter((id) => typeof id === 'string' && id !== '') })
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))

  // 探测接口：GET /probe?sessionId=... 报告该会话在宿主眼里是否还存在。
  ctx.effect(() => registerRoute(webServer, `${ROUTE_PREFIX}/probe`, async (req, res) => {
    try {
      const query = String(req.url ?? '').split('?')[1] ?? ''
      const params = new URLSearchParams(query)
      sendJson(res, await probeSession(params.get('sessionId') ?? ''))
    } catch (err) {
      sendJson(res, { ok: false, error: errText(err) }, 200)
    }
  }))
}

/**
 * 构造一套绑定到指定 DSH_HOME 的操作面。仅供验证脚本隔离测试使用，
 * 生产路径始终走上面的默认实例。
 *
 * @param {{ dshHome: string }} options 目标主目录。
 */
function createEngine(options) {
  const previous = P
  P = createPaths(options.dshHome)
  const restore = () => { P = previous }
  return {
    paths: P,
    trashSession: (input) => trashSession(input),
    trashOne: (sessionId, title) => trashOne(sessionId, title),
    restoreSession: (input) => restoreSession(input),
    listTrash: () => listTrash(),
    locateSessionDir: (sessionId) => locateSessionDir(sessionId),
    readRoster: () => readRoster(),
    collectDescendants: (roster, rootId) => collectDescendants(roster, rootId),
    encodeSegment: (raw) => encodeSegment(raw),
    projectKey: (cwd) => projectKey(cwd),
    dispose: restore,
  }
}

export { name, inject, apply, createEngine, encodeSegment, projectKey, collectDescendants, readRoster }
