# dsh-session-delete

A DSH plugin that adds **real session deletion**: a light-red **Delete** item in each session row's "…" menu, a **confirmation dialog**, and on confirm the session **plus all of its child sessions** are moved to a **recycle bin** (recoverable) and disappear from the sidebar and search.

> Why this exists: DSH only ships *archive*. Its `dsh-client-ui-workspace` docs state plainly — **"no Session deletion: sessions can be archived but are never deleted"** — and the persistence layer exposes no delete API at all. Cleaning up sessions for real means building it.

Deletion is **reversible**: files move to `$DSH_HOME/.dsh-session-trash/` byte-for-byte and can be restored at any time.

## What it looks like

- **Entry point**: hover a session row → "…" menu → **Delete** in its own group, after the shipped *Archive* row (trash icon).
- **Colour**: light red, taken from the theme's secondary error colour — lighter than the red the shipped `danger` style uses in light theme.
- **Confirmation dialog**:

  > **确定要删除这个会话吗？** (Delete this session?)
  > 「session title」
  > 该会话下的子会话（子代理）也会被一起删除。 ← small print
  > 删除后文件将会移入回收站。 (Files will be moved to the recycle bin.)

  Focus lands on *Confirm*; `Esc`, backdrop click and *Cancel* all dismiss.
- **After deleting**: the row disappears **immediately**, with a toast noting how many child sessions went with it.
- **Cascade**: every descendant child / sub-agent session (arbitrarily deep) is deleted too.

> The UI copy is Simplified Chinese, matching the plugin's primary audience. The dialog strings live in `lib/client.js` if you want to localise.

## Install

DSH's web and desktop surfaces are **two independent instances** (different profiles), so install once per surface.

### Web

```powershell
dsh plugin --profile web add link:<absolute path to this folder>
# e.g.
dsh plugin --profile web add link:D:\DSH插件\dsh-session-delete
```

### Desktop (Electron)

The desktop profile is **managed exclusively by the app**, so a plain `dsh --profile desktop …` is rejected. Use the CLI bundled with the desktop app:

```powershell
& "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:D:\DSH插件\dsh-session-delete
```

### Then restart DSH

**A restart is required.** The browser half's bundle is scanned into the boot graph **at startup**; the Host half's routes hot-reload with the profile. The two have different timing, which easily looks like "the plugin didn't load".

Uninstall:

```powershell
dsh plugin --profile web remove dsh-session-delete
```

Uninstalling only removes the plugin; files already in the recycle bin stay there.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Package manifest: `dsh.client` (platform `web`), `dsh.bundle.patch`, `exports["./client"]` |
| `cordis.patch.yml` | Mount declaration: inserts the plugin row into the profile's composition tree |
| `lib/index.js` | Host half: locates session directories, moves them to the recycle bin, cleans registries/caches, serves HTTP routes |
| `lib/client.js` | Client half: menu item, confirmation dialog, immediate row hiding (prebuilt classic script) |
| `scripts/check.mjs` | Isolated verification: runs the full delete/restore flow against a temp `DSH_HOME` |
| `docs/` | Development-time reconnaissance notes (design evidence, not runtime files) |

## How it works

### Deletion

- **Cascading children**: reads every session's `parentSessionId` to build a dependency tree, collects **all descendants** (any depth), and deletes **leaves first, root last** — so a mid-way failure never leaves an orphan pointing at a deleted parent. Traversal keeps a visited set to survive cyclic parent links.
- **Four cleanups** (skipping any one leaves ghost rows or stale data; each deleted session goes through all four):
  1. session directory → `$DSH_HOME/.dsh-session-trash/<trashId>/session` (atomic `rename` on the same volume, falls back to copy + delete across volumes);
  2. `storages/workspace.json` → removed from the workspace's `sessionIds`, `global.pinnedSessionIds` and `global.archivedSessionIds`;
  3. `storages/session_projcache/sessions/<id>.json` → deleted;
  4. `storages/session_projcache.json` → `tables.sessions[<id>]` entry removed.
- **Instant disappearance**: the row gets a hidden marker straight away, and a long-lived `MutationObserver` re-applies it whenever DSH re-renders — so the row cannot "come back".
- The session search index needs no intervention: `dsh-session-query-sqlite` reconciles before each search and drops rows for sessions that no longer exist.

### Recycle bin and restore

Each deleted session becomes its **own record** in the bin; the `trash.json` manifest records its original path, owning workspace, and pre-deletion archived state.

```powershell
# list
Invoke-RestMethod http://127.0.0.1:<port>/dsh-session-delete/api/list

# restore (one at a time)
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/dsh-session-delete/api/restore `
  -ContentType 'application/json' -Body '{"trashId":"<trashId from the list>"}'
```

Restore puts the session back into **the workspace it came from** (not an arbitrary one) and re-applies its archived state. Manual restore works too: move `.dsh-session-trash/<trashId>/session` back to the `originalDir` recorded in the manifest — the log bytes were never modified.

### Diagnostics

"Deleted it, but the row came back" has two very different causes: the file was not actually deleted, or it was deleted but the front-end list snapshot had not converged. `probe` separates the three independent facts in one call:

```powershell
Invoke-RestMethod 'http://127.0.0.1:<port>/dsh-session-delete/api/probe?sessionId=<session id>'
```

| Field | Meaning |
| --- | --- |
| `onDisk` | is the session directory still under the `sessions` root? (the real deletion result) |
| `inHostList` | does the Host's own session list still count it? (the sidebar's source) |
| `inTrash` | is it in the recycle bin? |

The classic "deleted fine but the row persists" shows `onDisk=false` / `inTrash=true` / `inHostList=true`, pointing at the Host's list snapshot rather than the deletion.

After a delete, the browser half also samples the DOM at 0 / 0.8 / 2.5 / 6 s (is the hidden marker still there, the effective `display`, all row keys on the page) and reports it to `$DSH_HOME/.dsh-session-delete-debug.jsonl`.

## Safety boundaries

| Situation | Behaviour |
| --- | --- |
| Session is **running** | **Refused.** The session log's writer holds no long-lived stream — every append re-opens the path with `open(path,"a")` — and on Windows the write lease is a named semaphore, not a file lock, so it **cannot stop the directory from being moved**. The next append would recreate a **headerless log** in place, tearing the session into two half files. |
| **A descendant is running** | The **whole subtree is refused**, reporting how many are running. No partial deletion. |
| Child list unreadable (`requireCascade`) | **Aborts** rather than silently deleting only the parent. |
| One descendant fails | The rest continue; the response carries `partial: true` and `failed[]`, and the UI says "deleted N, the rest failed". |
| `sessionId` contains a path separator or `..` | Refused (allowlist `[A-Za-z0-9._~-]`). |
| Session directory outside the `sessions` root | Refused; never operates out of bounds. |
| Target path already occupied on restore | Refused, **never overwritten**. |
| Move fails (cross-volume copy error, …) | The bin directory is rolled back and the original session is left untouched. |
| Registry/cache cleanup fails | Not rolled back (the session file is already safely moved); reported in the response's `cleanup`. |

**The recycle bin must live outside the `sessions` root.** DSH treats *every* directory under that root as a project directory, so a bin placed inside it would still be scanned as valid sessions. `$DSH_HOME/.dsh-session-trash/` is what makes deleted sessions truly vanish from listing, opening and search.

## Implementation notes

1. The **Host half** registers three functional routes plus two diagnostic routes via `webServer.register`, each wrapped in `ctx.effect` so it unregisters with the plugin's lifecycle. A statically installed plugin has no RPC bridge (that is a dynamic-package feature), so the client simply `fetch`es these relative paths.
2. **Session directory resolution** mirrors `dsh-session-persistence-jsonl`: `$DSH_HOME/sessions/--<normalised cwd>--/<escaped sessionId>/`. In the `cwd`, `\` `/` `:` collapse into one `-` and any other unsafe unit escapes as `~XXXX` (e.g. `D:\DSH插件` → `--D-DSH~63D2~4EF6--`); session ids escape the same way. It prefers computing the path from the workspace registry's `cwd` and falls back to scanning the `sessions` root. Both paths are strictly validated (inside the root, directory name equals the escaped id, and it really contains a session log).
3. **Registry writes** use a temp file plus `rename` for atomic replacement, serialised through a single-flight lock so concurrent read-modify-writes cannot corrupt `workspace.json`.
4. The **client half** registers with `window.__ModuleLoader__.load({ id, factory })` (the id must equal the package name) and occupies two slots: `sidebar.workspaces.session.menu.item` (order 500) and `shell.overlay` (the dialog). Its dependencies come from the platform seed table (`react`, `@deepseek-ai/dsh-client-ui-primitives`, …) — declare no runtime dependencies and do not bundle copies.

## Development

```powershell
cd dsh-session-delete
node scripts/check.mjs
```

The script builds a fake `DSH_HOME` in a temp directory and runs the real delete → cleanup → restore flow. **40 assertions** cover path encoding, both directory-resolution paths, the precision of all four cleanups (and that unrelated sessions are untouched), byte fidelity, restoring into the original workspace and archived state, the cascade tree (including cyclic-link defence), and a set of front-end regression guards (hidden marker + self-healing, persisted hide records, **asserting no full-page `reload` in the delete flow**, **asserting the observer never disconnects on a timer**).

## Known limitations

- **Running sessions cannot be deleted** (see the table above); stop them first.
- The **recycle bin is never auto-purged**. Restore manually via the API or by moving directories; delete `.dsh-session-trash/` entries you no longer want.
- A cascaded delete produces **several independent bin records**; restoring is one at a time.
- Deletion does **not** clean up image/file attachments referenced by the session (attachments are content-addressed and may be shared with other sessions).
- The immediate row hiding relies on the current `data-row-key="session:<id>"` DOM contract. If DSH changes it, the selector needs updating (`node scripts/check.mjs` has an assertion for it).

## License

MIT
