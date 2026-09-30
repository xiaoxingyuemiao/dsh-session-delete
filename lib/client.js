// dsh-session-delete —— Client 半边（静态安装版）
//
// 运行环境：浏览器。必须通过 __ModuleLoader__.load({ id, factory }) 注册工厂，
// 否则模块表在启动时抛 "bundle loaded without registering ... via __ModuleLoader__.load"。
// id 必须等于宿主行的 name（即包名 dsh-session-delete）；factory(require) 的返回值即模块导出。
//
// 提供的 UI：
//   1. sidebar.workspaces.session.menu.item —— 会话行「…」菜单里的浅红色「删除」按钮（order 500，排在归档之后）。
//   2. shell.overlay                        —— 二次确认弹窗；注册在 overlay 上，因此点「删除」关闭菜单后弹窗仍然存活。
//
// 与 Host 半边的通信：静态安装的插件没有动态包的 host.call 桥，因此走 Host 注册的 HTTP 路由
//   POST /dsh-session-delete/api/trash   { sessionId, title, workspaceId }
//   GET  /dsh-session-delete/api/list
//   POST /dsh-session-delete/api/restore { trashId }
//
// 依赖说明：react 与 @deepseek-ai/dsh-client-ui-primitives 都是外壳的 PLATFORM_MODULES 种子
// （见 dsh-web-frontend 的 staticModules），可在 factory 里直接 require，无需打包副本。

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { MenuItemButton, Modal, Button, IconTrashOutlineRegular, IconEllipsisOutlineRegular } = primitives

    const h = React.createElement

    const name = 'dsh-session-delete'
    const inject = ['slots']

    /** 诊断报告里带上，便于确认浏览器实际加载的是哪一版 bundle。 */
    const VERSION = '1.3.0'

    const API = '/dsh-session-delete/api'

    // ───────────────────────── 样式 ─────────────────────────
    // 浅红：优先用主题的「次级错误色」（比主错误色更浅，更接近浅红），
    // 主题没有该 token 时回退到主错误色，保证任何主题下都是红色系而不是掉成黑色。
    //
    // 注意两个实现约束（均已核对源码）：
    //   1. MenuItemButton 会丢弃 className —— 它的 props 只解构
    //      { children, shortcut, icon, disabled, danger, separatorBefore, onSelect }，
    //      没有把 ...rest 透传到 <button>。所以颜色不能靠给 MenuItemButton 传 class，
    //      必须在外层包一个带 class 的 span，再用后代选择器着色。
    //   2. .itemIcon 硬写了 color:var(--dsw-alias-menu-icon)，光给按钮上色图标仍是灰的，
    //      因此要额外让图标继承按钮颜色。
    // 选择器 .dsh-sd-row button[role="menuitem"] 权重 (0,1,1) 高于 .danger 的 (0,1,0)，
    // 无需 !important 即可覆盖。
    const LIGHT_RED = 'var(--dsw-alias-state-error-secondary, var(--dsw-alias-state-error-primary))'

    /** 标记被本地隐藏的会话行；配合下面的 CSS 规则让行立刻消失。 */
    const HIDDEN_ATTR = 'data-dsh-sd-hidden'

    const CSS = [
      '[' + HIDDEN_ATTR + ']{display:none!important}',
      '.dsh-sd-row button[role="menuitem"]{color:' + LIGHT_RED + '}',
      '.dsh-sd-row button[role="menuitem"] > span{color:inherit}',
      '.dsh-sd-dialog-body{display:flex;flex-direction:column;gap:10px;max-width:420px}',
      '.dsh-sd-target{font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}',
      /* 正文与「小黑字」：说明性内容比正文更小一号 */
      '.dsh-sd-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-sd-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sd-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sd-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-sd-danger{background:var(--dsw-alias-state-error-primary)!important;border-color:transparent!important;color:#fff!important}',
      '.dsh-sd-toast{position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:1200;' +
        'padding:8px 14px;border-radius:10px;font-size:12px;line-height:18px;' +
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);' +
        'box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.18));border:0.5px solid var(--dsw-alias-border-l1)}',
    ].join('')

    function insertCss(css) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-delete'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        try { tag.remove() } catch (err) { /* noop */ }
      }
    }

    // ───────────────────────── 弹窗状态（模块级，跨菜单项实例共享） ─────────────────────────
    // 菜单项在菜单关闭时会卸载，弹窗状态因此必须放在模块级；确认框由 shell.overlay 常驻渲染。
    const dialogState = {
      open: false,
      sessionId: '',
      title: '',
      busy: false,
      error: '',
      toast: '',
    }
    const listeners = new Set()

    function emit() {
      for (const listener of listeners) {
        try { listener() } catch (err) { /* noop */ }
      }
    }

    function setDialog(patch) {
      Object.assign(dialogState, patch)
      emit()
    }

    function useDialogState() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return dialogState
    }

    function showToast(text) {
      setDialog({ toast: text })
      window.setTimeout(() => {
        if (dialogState.toast === text) setDialog({ toast: '' })
      }, 2600)
    }

    // ───────────────────────── Host API ─────────────────────────

    async function apiPost(path, payload) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      return res.json()
    }

    function errText(err) {
      try {
        if (err && typeof err.message === 'string' && err.message !== '') return String(err.message)
        return String(err)
      } catch (e) {
        return '未知错误'
      }
    }

    // ─────────────────── 即时隐藏已删会话行（自愈） ───────────────────
    //
    // 为什么不能只打一次标记：DSH 侧栏重渲染时会**重建行元素**，标记随旧节点一起消失，
    // 于是刚删掉的会话又冒出来（此时文件其实已经删了）。
    //
    // 更早的版本还有两个自伤点，都已修掉：
    //   1. 删除成功后做整页 `location.reload()` —— 刷新会把本地的已隐藏集合一并清空，
    //      而宿主的会话列表快照此刻可能还没把该会话剔除，于是行重新出现。
    //      现在**完全不刷新**，纯靠本地隐藏 + 宿主自己收敛。
    //   2. 观察器 5 秒后自动断开 —— 恰好覆盖不到宿主稍后的刷新。现在常驻整页生命周期。
    //
    // 已隐藏集合用带过期时间的 localStorage 持久化：这样即使用户手动 F5，
    // 行也不会因为"忘了自己删过什么"而重新出现。过期时间保证记录不会永远留着，
    // 万一某个会话日后被恢复，最多 24 小时后它的行就会重新出现。

    const HIDDEN_STORE_KEY = 'dsh-session-delete:hidden'
    const HIDDEN_TTL_MS = 24 * 60 * 60 * 1000

    /** 本次页面会话中已删除的会话 id（跨刷新保留，带过期）。 */
    const hiddenIds = new Set(loadHiddenIds())
    let healObserver = null
    let healScheduled = false

    /** 读取持久化的已隐藏集合，顺手丢弃过期项。 */
    function loadHiddenIds() {
      try {
        const raw = window.localStorage.getItem(HIDDEN_STORE_KEY)
        if (raw === null || raw === '') return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const now = Date.now()
        return parsed
          .filter((row) => row !== null && typeof row === 'object')
          .filter((row) => typeof row.id === 'string' && row.id !== '' && Number(row.expiresAt) > now)
          .map((row) => row.id)
      } catch (e) {
        return []
      }
    }

    function saveHiddenIds() {
      try {
        const now = Date.now()
        const rows = Array.from(hiddenIds).map((id) => ({ id, expiresAt: now + HIDDEN_TTL_MS }))
        window.localStorage.setItem(HIDDEN_STORE_KEY, JSON.stringify(rows))
      } catch (e) {
        /* 隐私模式等场景下写不了，隐藏只在本次页面内有效，不影响删除正确性 */
      }
    }

    /** 一个会话 id 对应的行选择器。data-row-key 的形状由 ui-workspace 决定。 */
    function rowSelector(id) {
      return '[data-row-key="session:' + CSS_ESCAPE(id) + '"]'
    }

    /**
     * 幂等地给所有已删会话的行打隐藏标记，并返回当前仍能找到行的 id 集合。
     *
     * 不做「找不到就移除」的清理：侧栏可能因为折叠、搜索、切面板而暂时不渲染某行，
     * 误判会直接把隐藏状态丢掉，行就又回来了。宁可多留几个 tiny 记录。
     */
    function markHiddenRows() {
      if (hiddenIds.size === 0) return
      for (const id of hiddenIds) {
        let nodes = null
        try {
          nodes = document.querySelectorAll(rowSelector(id))
        } catch (e) {
          nodes = null
        }
        if (nodes === null) continue
        for (const node of nodes) {
          if (!node.hasAttribute(HIDDEN_ATTR)) node.setAttribute(HIDDEN_ATTR, '')
        }
      }
    }

    /** 用 rAF 把同一帧内的多次 DOM 变动合并成一次标记，避免观察器放大渲染开销。 */
    function scheduleHeal() {
      if (healScheduled) return
      healScheduled = true
      const run = () => {
        healScheduled = false
        markHiddenRows()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else window.setTimeout(run, 16)
    }

    /**
     * 记录已删会话、立刻隐藏它们的行，并启动常驻自愈。
     *
     * 之所以不给宿主打补丁：官方会话列表是 Host 快照驱动的只读投影，
     * 插件只通过 slot 拿到行身份、拿不到列表状态，也没有公开的「移除一行」接口，
     * 所以本地隐藏是唯一可行的即时手段；宿主最终会自己把该行从列表里收敛掉。
     *
     * @param {string[]} ids 已删除的会话 id。
     */
    function hideRows(ids) {
      for (const id of ids) {
        if (typeof id !== 'string' || id === '') continue
        hiddenIds.add(id)
      }
      saveHiddenIds()
      markHiddenRows()
      startHealing()
    }

    /**
     * 启动自愈观察器（只启一次，且**不再自动断开**）。
     *
     * 常驻是有意的：宿主可能在删除后过任意长时间才刷新一轮列表快照，
     * 那一轮重建行元素时正是需要重新打标记的时刻。
     * 每次变动只跑几个 querySelectorAll，且经 rAF 节流，开销可忽略。
     */
    function startHealing() {
      if (healObserver !== null || hiddenIds.size === 0) return
      if (typeof MutationObserver !== 'function') return
      healObserver = new MutationObserver(scheduleHeal)
      healObserver.observe(document.body, { childList: true, subtree: true })
    }

    /** CSS.escape 可能不存在（极旧内核），退化为只转义引号与反斜杠。 */
    function CSS_ESCAPE(value) {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
      return String(value).replace(/["\\]/g, '\\$&')
    }

    // ─────────────────── 诊断采集 ───────────────────
    //
    // 「删掉又被宿主刷新带回来」只发生在浏览器端，而插件在这里没有可读的日志通道。
    // 因此删除后按时间点采样「页面上与这些 id 相关的行元素」，回报给 Host 落盘。
    // 只为定位问题，正常删除流程不依赖它。

    /** 采集一次当前页面上与目标 id 相关的行状态。 */
    function sampleRows(ids) {
      const rows = []
      for (const id of ids) {
        let nodes = null
        try {
          nodes = document.querySelectorAll(rowSelector(id))
        } catch (e) {
          nodes = null
        }
        if (nodes === null) {
          rows.push({ id, count: 0, error: 'selector-failed' })
          continue
        }
        const entries = []
        for (const node of nodes) {
          const style = window.getComputedStyle(node)
          entries.push({
            // 隐藏标记是否还在（宿主重建行元素时会丢）
            marked: node.hasAttribute(HIDDEN_ATTR),
            // 实际是否可见：display 是最直接的判据
            display: style.display,
            visibility: style.visibility,
            offsetHeight: node.offsetHeight,
            rowKey: node.getAttribute('data-row-key'),
            className: String(node.className || '').slice(0, 120),
            text: String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          })
        }
        rows.push({ id, count: nodes.length, entries })
      }
      return rows
    }

    /** 采样页面上的全部行键，用于确认侧栏是否真的重渲染过。 */
    function sampleRowKeys() {
      try {
        const all = document.querySelectorAll('[data-row-key]')
        const keys = []
        for (let i = 0; i < all.length && i < 40; i += 1) keys.push(all[i].getAttribute('data-row-key'))
        return { total: all.length, keys }
      } catch (e) {
        return { total: -1, keys: [], error: errText(e) }
      }
    }

    /** 把一次诊断快照回报给 Host（失败静默，不能影响删除本身）。 */
    async function reportDebug(payload) {
      try {
        await apiPost('/debug', payload)
      } catch (e) {
        /* 诊断失败无所谓 */
      }
    }

    /**
     * 删除成功后按时间点采样，观察行会不会被宿主刷新带回来。
     * @param {string[]} ids 已删除的会话 id。
     * @param {object} hostResult Host 的原始返回。
     */
    function startDiagnostics(ids, hostResult) {
      const samples = []
      const marks = [0, 800, 2500, 6000]
      for (const delay of marks) {
        window.setTimeout(() => {
          samples.push({
            t: delay,
            rows: sampleRows(ids),
            rowKeys: sampleRowKeys(),
          })
          if (delay === marks[marks.length - 1]) {
            void reportDebug({
              kind: 'trash-followup',
              version: VERSION,
              url: String(window.location.href),
              ids,
              hostResult: {
                ok: hostResult?.ok === true,
                removedIds: hostResult?.removedIds ?? null,
                removedCount: hostResult?.removedCount ?? null,
                descendantCount: hostResult?.descendantCount ?? null,
              },
              hiddenIdsNow: Array.from(hiddenIds),
              samples,
            })
          }
        }, delay)
      }
    }

    async function doTrash() {
      if (dialogState.busy || dialogState.sessionId === '') return
      setDialog({ busy: true, error: '' })
      try {
        const res = await apiPost('/trash', {
          sessionId: dialogState.sessionId,
          title: dialogState.title,
          // 让 Host 在拿不到会话花名册（算不出子会话）时直接中止，
          // 而不是静默地只删掉父会话、把子会话留成孤儿。
          requireCascade: true,
        })
        if (res && res.ok === true) {
          const title = dialogState.title
          const ids = Array.isArray(res.removedIds) ? res.removedIds : [dialogState.sessionId]
          const extra = Number(res.descendantCount) || 0

          // 只做本地隐藏，**不重连、不刷新**。
          // 早先的版本在这里做整页 reload，结果把本地的 hiddenIds 一起清空，
          // 而宿主快照此刻可能还没剔除该会话，行就重新出现了。
          // 现在交给常驻的 MutationObserver：宿主无论何时重建行元素，都会被重新标记。
          hideRows(ids)
          setDialog({ open: false, busy: false, error: '', sessionId: '', title: '' })
          showToast(
            '已删除会话「' + (title || '未命名') + '」'
            + (extra > 0 ? '，连同 ' + extra + ' 个子会话' : '')
            + '，已移入回收站',
          )
          // 按时间点采样，观察行会不会被宿主刷新带回来（结果落盘到 DSH_HOME）。
          startDiagnostics(ids, res)
        } else {
          // 部分成功：Host 已经删掉了能删的，本地也要把已删的藏掉，避免看起来「没反应」。
          if (res && res.partial === true && Array.isArray(res.removedIds)) hideRows(res.removedIds)
          const base = (res && res.error) || '删除失败'
          setDialog({
            busy: false,
            error: res && res.partial === true
              ? `${base}（已删除 ${res.removedCount} 个，其余失败；刷新页面后列表会同步）`
              : base,
          })
        }
      } catch (err) {
        setDialog({ busy: false, error: '删除失败：' + errText(err) })
      }
    }

    // ───────────────────────── 组件 ─────────────────────────

    /** 会话行「…」菜单里的浅红色「删除」项。 */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState } = props
      const setMenuOpen = useMenuOpenState()[1]
      const onSelect = () => {
        // 先收起菜单，再交由常驻 overlay 渲染确认弹窗。
        try { setMenuOpen(false) } catch (err) { /* noop */ }
        setDialog({
          open: true,
          sessionId: String(sessionId || ''),
          title: typeof displayTitle === 'string' ? displayTitle : '',
          busy: false,
          error: '',
        })
      }
      // 必须包一层 span：MenuItemButton 会丢弃 className，颜色只能靠外层后代选择器。
      // 同时保留 danger prop，以便沿用官方红色 hover 底色。
      return h(
        'span',
        { className: 'dsh-sd-row' },
        h(
          MenuItemButton,
          {
            danger: true,
            separatorBefore: true,
            icon: h(IconTrashOutlineRegular, { size: 14 }),
            onSelect,
          },
          '删除',
        ),
      )
    }

    /** shell.overlay 上的二次确认弹窗。 */
    function DeleteSessionDialog() {
      const state = useDialogState()

      const close = () => {
        if (state.busy) return
        setDialog({ open: false, error: '', sessionId: '', title: '' })
      }

      const dialog = h(
        Modal,
        {
          open: state.open,
          onClose: close,
          title: '删除会话',
          closeLabel: '关闭',
          footer: h('div', { className: 'dsh-sd-actions' }, [
            h(Button, {
              key: 'cancel',
              variant: 'ghost',
              onClick: close,
              disabled: state.busy || undefined,
            }, '取消'),
            h(Button, {
              key: 'confirm',
              variant: 'primary',
              className: 'dsh-sd-danger',
              onClick: doTrash,
              disabled: state.busy || undefined,
              'data-modal-autofocus': true,
            }, state.busy ? '删除中…' : '确认删除'),
          ]),
        },
        h('div', { className: 'dsh-sd-dialog-body' }, [
          h('div', { className: 'dsh-sd-desc' }, '确定要删除这个会话吗？'),
          state.title !== ''
            ? h('div', { className: 'dsh-sd-target' }, '「' + state.title + '」')
            : null,
          // 小字提示：子会话级联
          h('div', { className: 'dsh-sd-note' }, '该会话下的子会话（子代理）也会被一起删除。'),
          h('div', { className: 'dsh-sd-desc' }, '删除后文件将会移入回收站。'),
          state.error !== '' ? h('div', { className: 'dsh-sd-err' }, state.error) : null,
        ]),
      )

      const toast = state.toast !== ''
        ? h('div', { className: 'dsh-sd-toast', role: 'status' }, state.toast)
        : null

      return h(React.Fragment, null, dialog, toast)
    }

    // ───────────────────────── 注册 ─────────────────────────

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return

      ctx.effect(() => insertCss(CSS))

      // 会话行「…」菜单项：order 500 排在官方归档（400）之后，并另起一个分组。
      ctx.effect(() => slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-delete', order: 500 },
        DeleteSessionMenuItem,
      )))

      // 确认弹窗：挂到 shell.overlay，独立于菜单项生命周期。
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-session-delete-dialog', order: 500 },
        DeleteSessionDialog,
      )))

      // 页面加载时若还压着本地隐藏记录，先补一次标记（覆盖「用户手动刷新」的场景），
      // 并回报一份启动快照，便于确认刷新后行到底有没有被藏住。
      if (hiddenIds.size > 0) {
        const ids = Array.from(hiddenIds)
        markHiddenRows()
        startHealing()
        window.setTimeout(() => {
          markHiddenRows()
          void reportDebug({
            kind: 'page-load',
            version: VERSION,
            url: String(window.location.href),
            ids,
            rows: sampleRows(ids),
            rowKeys: sampleRowKeys(),
          })
        }, 1200)
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
