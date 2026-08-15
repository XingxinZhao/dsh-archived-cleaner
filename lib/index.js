// dsh-archived-cleaner — Host half
//
// 功能：枚举已归档会话（workspaceRegistry 的归档集合），并把用户勾选的
// 会话日志目录移入 Windows 回收站（可恢复，非永久删除）。
//
// 与浏览器端通过 connection RPC 通道 `/arc-cln` 通信（authority: loopback，
// 仅接受本机回环页面的请求）。端点：
//   - candidates  { archivedIds?: string[] } -> { items, totalBytes }
//   - clean       { ids: string[] }          -> { moved, failed, skippedLive }
//
// 说明：DSH 的会话持久化是 append-only 事件日志，官方明确没有删除/保留 API
// （"pruning stored sessions is out-of-band backend maintenance"），本插件即
// 官方认可的"外部维护"路径：把 ~/.dsh/sessions/<项目>/<会话ID>/ 目录整体移入
// 回收站。SQLite 搜索索引会在下一次查询时自动同步掉已删除的会话。

export const name = 'archived-cleaner'

/** 硬依赖：等待 connection 服务（client-connection 的 node 半端）就绪后再 apply，确保 RPC 通道能注册。 */
export const inject = ['connection']

// ── 工具函数 ──────────────────────────────────────────────────────────────

function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

function numOrNull(n) {
  return typeof n === 'number' ? n : null
}

function errMsg(e) {
  return String((e && e.message) || e)
}

function isTooLarge(e) {
  const s = String((e && (e.code || e.message)) || e)
  return s.includes('FS_TOO_LARGE') || s.includes('too large')
}

/** 递归统计一个目录占用字节数（深度上限 8）。 */
async function dirSize(fs, target, depth) {
  let info
  try {
    info = await fs.stat(target)
  } catch {
    return 0
  }
  if (!info) return 0
  if (info.type === 'file') return typeof info.size === 'number' ? info.size : 0
  if (info.type !== 'directory' || depth > 8) return 0
  let entries = []
  try {
    entries = await fs.listDir(target)
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    if (e.type === 'file') total += typeof e.size === 'number' ? e.size : 0
    else if (e.type === 'directory') total += await dirSize(fs, e.target, depth + 1)
  }
  return total
}

/** PowerShell 单引号转义。 */
function sq(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * 生成把多个目录移入回收站的 PowerShell 脚本。
 * 每处理一个目录输出一行 `OK <index>` 或 `ERR <index>: <原因>`，
 * 宿主据此逐个映射成功/失败，互不影响。
 */
function buildScript(paths) {
  const list = paths.map(sq).join(', ')
  return [
    '$ErrorActionPreference = "Continue"',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$paths = @(' + list + ')',
    'for ($i = 0; $i -lt $paths.Count; $i++) {',
    '  try {',
    '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($paths[$i], "OnlyErrorDialogs", "SendToRecycleBin")',
    '    Write-Output ("OK " + $i)',
    '  } catch {',
    '    Write-Output ("ERR " + $i + ": " + $_.Exception.Message)',
    '  }',
    '}',
  ].join('\n')
}

/** 归档集合：优先读 Host workspaceRegistry 的持久化 getter，再并入客户端上报的 id。 */
async function collectArchivedSet(ctx, clientIds) {
  const archived = []
  const registry = ctx.get('workspaceRegistry')
  if (registry) {
    try {
      const ids = registry.archivedSessionIds
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && !archived.includes(id)) archived.push(id)
        }
      }
    } catch {
      /* getter 不可用时依赖客户端上报 */
    }
  }
  if (Array.isArray(clientIds)) {
    for (const id of clientIds) {
      if (typeof id === 'string' && !archived.includes(id)) archived.push(id)
    }
  }
  return archived
}

/** 按 id 找会话记录（sessionQuery 优先，退化为 persistence.list）。 */
async function findRecord(ctx, byId, id) {
  if (byId.has(id)) return byId.get(id)
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery) {
    try {
      const records = await sessionQuery.listSessions()
      for (const r of records) {
        if (r && r.header && r.header.id) byId.set(r.header.id, r)
      }
    } catch {
      /* 忽略 */
    }
  }
  return byId.get(id)
}

// ── RPC 端点 ──────────────────────────────────────────────────────────────

async function candidates(ctx, payload) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = ctx.get('sessionQuery')
  const fs = ctx.get('fs')
  const archived = await collectArchivedSet(ctx, payload && payload.archivedIds)
  if (archived.length === 0) return { items: [], totalBytes: 0 }

  const byId = new Map()
  if (sessionQuery) {
    try {
      const records = await sessionQuery.listSessions()
      for (const r of records) {
        if (r && r.header && r.header.id) byId.set(r.header.id, r)
      }
    } catch (e) {
      console.warn('archived-cleaner: listSessions failed', e)
    }
  } else if (persistence) {
    try {
      const headers = await persistence.list()
      for (const h of headers) {
        byId.set(h.id, { header: h, live: !!(sessions && sessions.get(h.id)), persisted: true })
      }
    } catch (e) {
      console.warn('archived-cleaner: persistence list failed', e)
    }
  }

  const items = []
  let totalBytes = 0
  for (const id of archived) {
    const rec = byId.get(id)
    const live = rec ? rec.live === true : !!(sessions && sessions.get(id))
    const header = rec ? rec.header : undefined
    const createdAt = header && header.createdAt ? header.createdAt : undefined
    let title = id
    if (sessionQuery && header) {
      try {
        const snap = await sessionQuery.readTitle(id)
        if (snap && typeof snap.title === 'string' && snap.title) title = snap.title
      } catch {
        /* 保留 id */
      }
    }
    if (live) {
      items.push({ id, title, dir: null, size: 0, live: true, createdAt })
      continue
    }
    if (!rec || !header || rec.persisted === false) continue
    let loc
    try {
      loc = persistence ? persistence.locate(header) : undefined
    } catch {
      loc = undefined
    }
    if (!loc || typeof loc.path !== 'string' || !loc.path) continue
    const dir = dirname(loc.path)
    let size = 0
    if (fs) {
      try {
        const target = await fs.resolve(dir)
        size = await dirSize(fs, target, 0)
      } catch {
        size = -1
      }
    }
    totalBytes += Math.max(size, 0)
    items.push({ id, title, dir, size, live: false, createdAt })
  }
  return { items, totalBytes }
}

async function clean(ctx, payload) {
  const ids = Array.isArray(payload && payload.ids)
    ? payload.ids.filter((s) => typeof s === 'string')
    : []
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = ctx.get('sessionQuery')
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')

  // 逐 id 复核：跳过 live 会话、定位日志目录、确认目录存在。
  const targets = []
  const byId = new Map()
  for (const id of ids) {
    if (sessions && sessions.get(id)) continue
    const rec = await findRecord(ctx, byId, id)
    if (!rec || !rec.header) continue
    let loc
    try {
      loc = persistence ? persistence.locate(rec.header) : undefined
    } catch {
      loc = undefined
    }
    if (!loc || typeof loc.path !== 'string' || !loc.path) continue
    const dir = dirname(loc.path)
    if (fs) {
      try {
        const t = await fs.resolve(dir)
        const info = await fs.stat(t)
        if (!info || info.type !== 'directory') continue
      } catch {
        continue
      }
    }
    targets.push({ id, dir })
  }
  if (targets.length === 0) return { moved: [], failed: [], skippedLive: 0 }

  const moved = []
  const failed = []
  if (!subprocess) {
    for (const t of targets) failed.push({ id: t.id, error: 'subprocess service unavailable' })
    return { moved, failed, skippedLive: 0 }
  }

  const script = buildScript(targets.map((t) => t.dir))
  let exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  try {
    const resolved = await subprocess.resolveExecutable('powershell.exe')
    if (resolved) exe = resolved
  } catch {
    /* 保留绝对路径兜底 */
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: [exe, '-NoProfile', '-NonInteractive', '-Command', script],
      cwd: dirname(targets[0].dir),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 30000,
    })
  } catch (e) {
    for (const t of targets) failed.push({ id: t.id, error: 'spawn failed: ' + errMsg(e) })
    return { moved, failed, skippedLive: 0 }
  }
  const outcome = await handle.done
  const stdoutText =
    handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
  const stderrText =
    handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
  const results = new Map()
  for (const line of String(stdoutText).split(/\r?\n/)) {
    const m = /^(OK|ERR) (\d+)(?:: (.*))?$/.exec(line.trim())
    if (m) results.set(Number(m[2]), { ok: m[1] === 'OK', error: m[1] === 'ERR' ? m[3] || 'unknown error' : undefined })
  }
  targets.forEach((t, i) => {
    const r = results.get(i)
    if (r && r.ok) {
      moved.push(t.id)
    } else {
      failed.push({
        id: t.id,
        error: r
          ? r.error || 'no result line'
          : 'powershell exit ' + outcome.exitCode + (stderrText ? ': ' + String(stderrText).trim().slice(0, 300) : ''),
      })
    }
  })
  return { moved, failed, skippedLive: 0 }
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const connection = ctx.get('connection')
  if (!connection || !connection.rpc || typeof connection.rpc.handle !== 'function') {
    console.warn('archived-cleaner: connection service unavailable; host RPC disabled')
    return
  }
  ctx.effect(() =>
    connection.rpc.handle(
      '/arc-cln',
      async (endpoint, payload) => {
        try {
          if (endpoint === 'candidates') return { ok: true, value: await candidates(ctx, payload) }
          if (endpoint === 'clean') return { ok: true, value: await clean(ctx, payload) }
          return { ok: false, error: { code: 'internal', message: 'unknown endpoint: ' + endpoint, details: {} } }
        } catch (e) {
          return { ok: false, error: { code: 'internal', message: errMsg(e), details: {} } }
        }
      },
      { authority: 'loopback' },
    ),
  )
}
