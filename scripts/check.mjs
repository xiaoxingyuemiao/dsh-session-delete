// dsh-session-delete —— 隔离验证脚本
//
// 在临时目录里造一套假的 DSH_HOME（sessions / storages / 回收站），跑完整的
// 「删除 → 清理 → 恢复」流程。绝不接触用户真实的 ~/.dsh。
//
// 运行：node scripts/check.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createEngine, encodeSegment, projectKey, collectDescendants, readRoster } from '../lib/index.js'

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${label}`)
    console.log(`      ${err && err.message ? err.message : String(err)}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${label}`)
    console.log(`      ${err && err.message ? err.message : String(err)}`)
  }
}

// ───────────────────── 1. 路径编码规则（与官方 jsonl 后端一致） ─────────────────────

console.log('\n[1] 路径编码规则')

check('projectKey 折叠分隔符与冒号', () => {
  assert.equal(projectKey('D:\\DSH'), '--D-DSH--')
})

check('projectKey 对非 ASCII 字符用 ~XXXX 转义', () => {
  // “插件” = U+63D2 U+4EF6
  assert.equal(projectKey('D:\\DSH插件'), '--D-DSH~63D2~4EF6--')
})

check('encodeSegment 保留安全字符', () => {
  assert.equal(
    encodeSegment('session-91f8dc6b-df05-4471-92b3-a41bff0abbe9'),
    'session-91f8dc6b-df05-4471-92b3-a41bff0abbe9',
  )
})

check('encodeSegment 转义点号与波浪号', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

// ───────────────────── 2. 在临时 DSH_HOME 上跑真实流程 ─────────────────────

console.log('\n[2] 删除 / 清理 / 恢复 全流程')

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-delete-check-'))
const sessionsRoot = path.join(tmpHome, 'sessions')
const trashRoot = path.join(tmpHome, '.dsh-session-trash')
const storages = path.join(tmpHome, 'storages')

const CWD = 'D:\\DSH插件'
const OTHER_CWD = 'D:\\xingyue'
const THIRD_CWD = 'D:\\third-workspace'
const TARGET = 'session-91f8dc6b-df05-4471-92b3-a41bff0abbe9'
const KEEP = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function writeSession(cwd, sessionId, marker) {
  const dir = path.join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from(marker, 'utf8'))
  return dir
}

function writeWorkspaceStore() {
  fs.mkdirSync(storages, { recursive: true })
  const store = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      // 注意：ws-empty 刻意排在 ws-1 之前，用来抓住「恢复时挑错工作区」的回归
      workspaceIds: ['ws-empty', 'ws-1', 'ws-2'],
      archivedSessionIds: [TARGET, KEEP],
      pinnedSessionIds: [TARGET],
    },
    tables: {
      workspaces: {
        // 一个先出现的、非空的无关工作区：恢复必须**不能**把会话塞进这里
        'ws-empty': { path: THIRD_CWD, title: 'third', sessionIds: [KEEP] },
        'ws-1': { path: CWD, title: 'DSH插件', sessionIds: [TARGET, KEEP] },
        'ws-2': { path: OTHER_CWD, title: 'xingyue', sessionIds: [] },
      },
    },
  }
  fs.writeFileSync(path.join(storages, 'workspace.json'), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function writeProjCaches() {
  fs.mkdirSync(path.join(storages, 'session_projcache', 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(storages, 'session_projcache', 'sessions', `${TARGET}.json`),
    '{"derived":true}',
    'utf8',
  )
  const root = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions: { [TARGET]: { identity: { cwd: CWD } }, [KEEP]: { identity: { cwd: OTHER_CWD } } } },
  }
  fs.writeFileSync(path.join(storages, 'session_projcache.json'), JSON.stringify(root), 'utf8')
}

writeSession(CWD, TARGET, 'TARGET-SESSION-BYTES')
writeSession(OTHER_CWD, KEEP, 'KEEP-SESSION-BYTES')
writeWorkspaceStore()
writeProjCaches()

const engine = createEngine({ dshHome: tmpHome })

await checkAsync('locateSessionDir 依据注册表 cwd 直接命中', async () => {
  const found = engine.locateSessionDir(TARGET)
  assert.ok(found, '未定位到会话目录')
  assert.ok(found.dir.endsWith(encodeSegment(TARGET)), `目录名不符：${found.dir}`)
  assert.ok(found.dir.includes(projectKey(CWD)), `未落在预期项目目录：${found.dir}`)
})

await checkAsync('locateSessionDir 在注册表无记录时靠扫描兜底', async () => {
  const orphan = 'session-99999999-8888-7777-6666-555555555555'
  writeSession('D:\\某个没有登记的项目', orphan, 'ORPHAN')
  const found = engine.locateSessionDir(orphan)
  assert.ok(found, '扫描兜底未命中')
})

let trashResult = null

await checkAsync('trashSession 成功并报告清理结果', async () => {
  trashResult = await engine.trashSession({ sessionId: TARGET, title: '测试会话标题' })
  assert.equal(trashResult.ok, true, `删除失败：${JSON.stringify(trashResult)}`)
  assert.equal(trashResult.removedCount, 1, '应只删掉一个会话（没有子会话）')
  assert.equal(trashResult.descendantCount, 0, '不应有子会话')
  // 逐会话的清理详情挂在 removed[] 上
  const entry = trashResult.removed[0]
  assert.equal(entry.sessionId, TARGET)
  assert.equal(entry.title, '测试会话标题')
  assert.equal(entry.isRoot, true)
  assert.equal(entry.cleanup.workspace.changed, true, 'workspace.json 未被清理')
  assert.ok(entry.cleanup.projectionCache >= 2, '投影缓存未清理干净')
})

const trashedId = () => trashResult.removed[0].trashId

// 清单在 restore 时会被一并清掉，所以趁热读出来留给后面的断言。
const trashManifest = JSON.parse(
  fs.readFileSync(path.join(trashRoot, trashedId(), 'trash.json'), 'utf8'),
)

check('回收站清单记下了原工作区与归档状态（恢复才能放回原处）', () => {
  assert.equal(trashManifest.workspaceId, 'ws-1', '未记录原工作区 id')
  assert.equal(trashManifest.cwd, CWD, '未记录项目目录')
  assert.equal(trashManifest.archived, true, '未记录删除前的归档状态')
})

check('回收站清单记录了原始路径', () => {
  assert.equal(trashManifest.sessionId, TARGET)
  assert.equal(trashManifest.title, '测试会话标题')
  assert.ok(trashManifest.originalDir.includes(encodeSegment(TARGET)))
})

check('原会话目录已从 sessions 根移走', () => {
  const original = path.join(sessionsRoot, projectKey(CWD), encodeSegment(TARGET))
  assert.equal(fs.existsSync(original), false, '原目录仍然存在')
})

check('会话字节完整落到回收站', () => {
  const bytes = fs.readFileSync(path.join(trashRoot, trashedId(), 'session', 'session.v4.jsonl.zstd'), 'utf8')
  assert.equal(bytes, 'TARGET-SESSION-BYTES', '字节不一致，备份不可信')
})

check('workspace.json 已摘掉成员/置顶/归档记录', () => {
  const store = JSON.parse(fs.readFileSync(path.join(storages, 'workspace.json'), 'utf8'))
  assert.equal(store.global.pinnedSessionIds.includes(TARGET), false, '置顶未清理')
  assert.equal(store.global.archivedSessionIds.includes(TARGET), false, '归档未清理')
  assert.equal(store.tables.workspaces['ws-1'].sessionIds.includes(TARGET), false, '工作区成员未清理')
  // 其他会话必须原样保留
  assert.equal(store.global.pinnedSessionIds.length, 0)
  assert.equal(store.global.archivedSessionIds.includes(KEEP), true, '误删了其他会话的归档记录')
  assert.deepEqual(store.tables.workspaces['ws-1'].sessionIds, [KEEP], '误删了其他会话成员')
  assert.equal(store.tables.workspaces['ws-empty'].sessionIds.includes(KEEP), true, '动了无关工作区')
})

check('投影缓存文件与根索引条目均已清理', () => {
  assert.equal(
    fs.existsSync(path.join(storages, 'session_projcache', 'sessions', `${TARGET}.json`)),
    false,
    '每会话投影文件仍在',
  )
  const root = JSON.parse(fs.readFileSync(path.join(storages, 'session_projcache.json'), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(root.tables.sessions, TARGET), false, '根索引条目仍在')
  assert.equal(Object.prototype.hasOwnProperty.call(root.tables.sessions, KEEP), true, '误删了其他会话的根索引')
})

check('无关会话安然无恙', () => {
  const keepDir = path.join(sessionsRoot, projectKey(OTHER_CWD), encodeSegment(KEEP))
  assert.equal(fs.existsSync(keepDir), true, '无关会话被误删')
})

check('listTrash 能列出回收站内容', () => {
  const items = engine.listTrash()
  assert.equal(items.length, 1, `回收站条目数异常：${items.length}`)
  assert.equal(items[0].sessionId, TARGET)
  assert.ok(items[0].bytes > 0, '未统计到字节数')
})

await checkAsync('restoreSession 能把会话原样放回原位', async () => {
  const restored = await engine.restoreSession({ trashId: trashedId() })
  assert.equal(restored.ok, true, `恢复失败：${JSON.stringify(restored)}`)
  const original = path.join(sessionsRoot, projectKey(CWD), encodeSegment(TARGET))
  assert.equal(fs.existsSync(original), true, '恢复后原路径不存在')
  assert.equal(
    fs.readFileSync(path.join(original, 'session.v4.jsonl.zstd'), 'utf8'),
    'TARGET-SESSION-BYTES',
    '恢复后的字节与原始不一致',
  )
  assert.equal(fs.existsSync(path.join(trashRoot, trashedId())), false, '回收站目录未清空')
})

check('恢复后会话回到**原来那个**工作区，而不是第一个非空工作区', () => {
  const store = JSON.parse(fs.readFileSync(path.join(storages, 'workspace.json'), 'utf8'))
  assert.equal(store.tables.workspaces['ws-1'].sessionIds.includes(TARGET), true, '没有回到原工作区')
  // 回归护栏：ws-empty 在 workspaceIds 里排在 ws-1 之前，旧的「挑第一个」实现会误放这里
  assert.equal(
    store.tables.workspaces['ws-empty'].sessionIds.includes(TARGET),
    false,
    '被错误地并进了别的工作区',
  )
})

check('恢复后还原「已归档」状态', () => {
  const store = JSON.parse(fs.readFileSync(path.join(storages, 'workspace.json'), 'utf8'))
  assert.equal(
    store.global.archivedSessionIds.includes(TARGET),
    true,
    '原本已归档的会话恢复后变成了普通会话',
  )
})

// ───────────────────── 3. 错误与安全边界 ─────────────────────

console.log('\n[3] 错误与安全边界')

await checkAsync('对不存在的会话返回 not-found 而不是抛错', async () => {
  const res = await engine.trashSession({ sessionId: 'session-does-not-exist' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'not-found')
})

await checkAsync('缺少 sessionId 被拒绝', async () => {
  const res = await engine.trashSession({})
  assert.equal(res.ok, false)
})

await checkAsync('路径穿越形式的 sessionId 被拒绝', async () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', 'session-x/../y']) {
    const res = await engine.trashSession({ sessionId: bad })
    assert.equal(res.ok, false, `未拒绝：${bad}`)
  }
})

await checkAsync('非法 trashId 被拒绝', async () => {
  for (const bad of ['..', '../../x', 'a/b']) {
    const res = await engine.restoreSession({ trashId: bad })
    assert.equal(res.ok, false, `未拒绝：${bad}`)
  }
})

await checkAsync('原位置被占用时拒绝恢复而不是覆盖', async () => {
  const second = await engine.trashSession({ sessionId: TARGET, title: '第二次' })
  assert.equal(second.ok, true, '第二次删除失败')
  const secondTrashId = second.removed[0].trashId
  // 手工造一个占位目录，模拟原位置已有内容
  const original = path.join(sessionsRoot, projectKey(CWD), encodeSegment(TARGET))
  fs.mkdirSync(original, { recursive: true })
  fs.writeFileSync(path.join(original, 'session.v4.jsonl.zstd'), 'PLACEHOLDER', 'utf8')
  const res = await engine.restoreSession({ trashId: secondTrashId })
  assert.equal(res.ok, false, '应当拒绝恢复')
  assert.match(String(res.error), /占用/, `错误信息不符：${res.error}`)
  // 占位内容必须完好，没有被覆盖
  assert.equal(fs.readFileSync(path.join(original, 'session.v4.jsonl.zstd'), 'utf8'), 'PLACEHOLDER')
})

engine.dispose()

// ───────────────────── 4. 子会话级联 ─────────────────────

console.log('\n[4] 子会话级联')

// collectDescendants 是纯函数，用合成花名册验证依赖树遍历。
// 结构：root ├─ child1 ── grandchild
//              └─ child2
//       unrelated（无关会话，不能被带出来）
const ROOT = 'session-root-0000'
const CHILD1 = 'session-child1-1111'
const CHILD2 = 'session-child2-2222'
const GRAND = 'session-grand-3333'
const UNRELATED = 'session-unrelated-4444'

const roster = [
  { sessionId: ROOT, parentSessionId: null, origin: null, running: false },
  { sessionId: CHILD1, parentSessionId: ROOT, origin: 'subagent', running: false },
  { sessionId: CHILD2, parentSessionId: ROOT, origin: 'subagent', running: false },
  { sessionId: GRAND, parentSessionId: CHILD1, origin: 'subagent', running: false },
  { sessionId: UNRELATED, parentSessionId: null, origin: null, running: false },
]

check('collectDescendants 找出全部后代（含更深层嵌套）', () => {
  const ids = collectDescendants(roster, ROOT).map((row) => row.sessionId)
  assert.deepEqual(ids.slice().sort(), [CHILD1, CHILD2, GRAND].sort())
})

check('collectDescendants 保证子排在父之前（可先删叶后删根）', () => {
  const ids = collectDescendants(roster, ROOT).map((row) => row.sessionId)
  assert.ok(ids.indexOf(GRAND) < ids.indexOf(CHILD1), '孙会话应排在子会话之前')
})

check('collectDescendants 不牵连无关会话', () => {
  const ids = collectDescendants(roster, ROOT).map((row) => row.sessionId)
  assert.equal(ids.includes(UNRELATED), false, '带出了无关会话')
})

check('collectDescendants 对无子会话的叶子返回空', () => {
  assert.deepEqual(collectDescendants(roster, GRAND), [])
})

check('collectDescendants 能抵御环形父子引用', () => {
  const cyclic = [
    { sessionId: 'a', parentSessionId: 'b' },
    { sessionId: 'b', parentSessionId: 'a' },
  ]
  const ids = collectDescendants(cyclic, 'a').map((row) => row.sessionId)
  assert.deepEqual(ids, ['b'], '环形引用应被去重截断而不是无限递归')
})

await checkAsync('拿不到会话花名册时，带 requireCascade 的删除会中止而不是半删', async () => {
  // 校验脚本进程里没有挂载 sessionController，readRoster 必然返回 undefined，
  // 正好模拟「花名册读取失败」这一真实降级场景。
  assert.equal(await readRoster(), undefined, '本进程不应有 sessionController')
  const local = createEngine({ dshHome: tmpHome })
  try {
    const res = await local.trashSession({ sessionId: TARGET, requireCascade: true })
    assert.equal(res.ok, false, '应当中止')
    assert.equal(res.code, 'cascade-unavailable')
  } finally {
    local.dispose()
  }
})

// ───────────────────── 5. 包清单与源码静态检查 ─────────────────────

console.log('\n[5] 包清单与源码静态检查')

const pkgRoot = path.resolve(import.meta.dirname, '..')

check('package.json 声明了 web 客户端与 bundle patch', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
})

check('cordis.patch.yml 插入了同名插件行', () => {
  const yml = fs.readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(yml, /id:\s*dsh-session-delete/)
  assert.match(yml, /name:\s*dsh-session-delete/)
})

check('客户端半边注册了菜单项与 overlay 弹窗', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  assert.match(src, /__ModuleLoader__\.load\(\{/)
  assert.match(src, /id:\s*'dsh-session-delete'/)
  assert.match(src, /sidebar\.workspaces\.session\.menu\.item/)
  assert.match(src, /shell\.overlay/)
  assert.match(src, /state-error-secondary/, '未使用更浅的次级错误色')
})

check('客户端半边 id 与包名一致（否则模块表启动时会在表里报错）', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.match(src, new RegExp(`id:\\s*'${pkg.name}'`))
})

check('客户端半边实现了「即时隐藏会话行」且能扛住重渲染', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  // 行的定位属性来自 ui-workspace 的渲染：data-row-key="session:<id>"
  assert.match(src, /data-row-key="session:/, '未按 data-row-key 定位会话行')
  assert.match(src, /data-dsh-sd-hidden/, '缺少本地隐藏标记')
  assert.match(src, /display:none/, '缺少隐藏标记对应的 CSS 规则')
  // 关键：只打一次标记扛不住重渲染。DSH 会重建行元素，标记随旧节点丢失，行会「复活」。
  assert.match(src, /MutationObserver/, '缺少重渲染自愈，行会在 DSH 刷新后复活')
  assert.match(src, /function markHiddenRows/, '缺少幂等的重新标记')
})

check('隐藏记录跨刷新保留（否则手动 F5 后行会复活）', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  assert.match(src, /localStorage/, '未持久化隐藏记录，刷新后行会复活')
  assert.match(src, /HIDDEN_TTL_MS/, '缺少过期时间，记录可能永远压着行')
  assert.match(src, /expiresAt/, '未按过期时间过滤')
})

check('删除后不再做整页重连（重连会清空隐藏记录，正是「复活」的成因）', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  // 去掉注释行后再断言，避免说明文字里的历史引用误伤
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.equal(
    /location\s*\.\s*reload/.test(code),
    false,
    '删除流程里仍有整页重连，会重新触发「删掉又出现」',
  )
})

check('观测器常驻而不是定时断开', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  assert.equal(
    /stopHealing/.test(src),
    false,
    '仍存在定时断开观察器的逻辑，会覆盖不到宿主稍后的刷新',
  )
})

check('确认框文案与字号层级符合要求', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  assert.match(src, /确定要删除这个会话吗？/, '缺少主问句')
  assert.match(src, /该会话下的子会话（子代理）也会被一起删除。/, '缺少子会话小字提示')
  assert.match(src, /删除后文件将会移入回收站。/, '缺少回收站说明')
  // 子会话那句要用很小的字
  assert.match(src, /\.dsh-sd-note\{font-size:11px/, '小字样式缺失或字号不对')
  assert.match(src, /\.dsh-sd-desc\{font-size:13px/, '正文样式缺失或字号不对')
})

check('客户端半边声明了子会话级联语义', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  assert.match(src, /requireCascade:\s*true/, '未要求 Host 保证级联完整')
  assert.match(src, /removedIds/, '未读取 Host 返回的已删列表')
})

check('Host 半边实现了级联删除与运行中整树防护', () => {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'index.js'), 'utf8')
  assert.match(src, /collectDescendants/, '缺少后代收集')
  assert.match(src, /parentSessionId/, '未依据 parentSessionId 建树')
  assert.match(src, /cascade-unavailable/, '缺少花名册不可用时的中止保护')
})

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exitCode = 1
