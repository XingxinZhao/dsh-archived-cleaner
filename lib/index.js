// dsh-archived-cleaner — Host half
//
// 功能：枚举已归档会话（workspaceRegistry 的归档集合），并把用户勾选的
// 会话日志目录移入 Windows 回收站（可恢复，非永久删除）。可选地（withImages）
// 同时清理“仅被这些会话引用”的附件图片：解析被清理会话日志中的 attachment
// 引用，再对所有剩余会话做引用计数，只把引用数为 0 的附件移入回收站，
// 避免误删仍被其他会话使用的图片。
//
// 与浏览器端通过 connection RPC 通道 `/arc-cln` 通信（authority: loopback，
// 仅接受本机回环页面的请求）。端点：
//   - candidates  { archivedIds?: string[] } -> { items, totalBytes }
//   - clean       { ids: string[], withImages?: boolean }
//                 -> { moved, failed, skippedLive, attachments?: { moved, skipped } }
//
// 说明：DSH 的会话持久化是 append-only 事件日志，官方明确没有删除/保留 API
// （"pruning stored sessions is out-of-band backend maintenance"），本插件即
// 官方认可的"外部维护"路径：把 ~/.dsh/sessions/<项目>/<会话ID>/ 目录整体移入
// 回收站。SQLite 搜索索引会在下一次查询时自动同步掉已删除的会话。

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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

// ── 附件引用提取（zstd 多 frame 日志）────────────────────────────────────

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 little-endian
const ATTACH_RE = /sha256:([a-f0-9]{64})/g

/**
 * Locate complete Zstandard frames without decompressing their blocks
 * (same container format as dsh-session-persistence-jsonl: appended frames,
 * each independently decodable and checksummed).
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break // reserved frame-header bit
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return frames // reserved block type
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decompress a concatenated-frame .jsonl.zstd session log into plaintext. */
function decompressSessionLog(buffer) {
  const frames = scanZstdFrames(buffer)
  let out = ''
  for (const f of frames) {
    try {
      out += zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8')
    } catch {
      /* skip a corrupt frame; keep going */
    }
  }
  return out
}

/**
 * Extract attachment ids (sha256:...) referenced by one session log file.
 * Only reads the log; never touches the attachment store.
 * @returns array of full attachment ids, e.g. "sha256:abcd…"
 */
function attachmentIdsOfLogFile(filePath) {
  let buf
  try {
    buf = readFileSync(filePath)
  } catch {
    return []
  }
  const plain = decompressSessionLog(buf)
  const ids = []
  for (const m of plain.matchAll(ATTACH_RE)) {
    if (!ids.includes(`sha256:${m[1]}`)) ids.push(`sha256:${m[1]}`)
  }
  return ids
}

/** Locate the session log file for a session directory, if present. */
function sessionLogPath(dir) {
  return join(dir, 'session.jsonl.zstd')
}

/**
 * Recursively enumerate every session log path under a sessions root.
 * @param root - absolute DSH_HOME/sessions directory.
 * @returns array of absolute session.jsonl.zstd paths.
 */
function enumerateSessionLogs(root) {
  const out = []
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of dirs) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sess of sessions) {
      if (!sess.isDirectory()) continue
      const log = sessionLogPath(join(root, project.name, sess.name))
      try {
        if (statSync(log).isFile()) out.push(log)
      } catch {
        /* no log file in this session dir */
      }
    }
  }
  return out
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
 * @param paths - 目录路径数组。
 * @param files - 可选：附加的文件路径数组，同样移入回收站（DeleteFile）。
 * 文件的行号从目录之后继续编号。
 */
function buildScript(paths, files = []) {
  const list = paths.map(sq).join(', ')
  const fileList = files.map(sq).join(', ')
  const base = files.length > 0
    ? 'if ($filePaths.Count -gt 0) { for ($j = 0; $j -lt $filePaths.Count; $j++) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($filePaths[$j], "OnlyErrorDialogs", "SendToRecycleBin"); Write-Output ("OK " + ($dirCount + $j)) } catch { Write-Output ("ERR " + ($dirCount + $j) + ": " + $_.Exception.Message) } } }'
    : ''
  return [
    '$ErrorActionPreference = "Continue"',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$dirs = @(' + list + ')',
    '$dirCount = $dirs.Count',
    '$filePaths = @(' + fileList + ')',
    'for ($i = 0; $i -lt $dirs.Count; $i++) {',
    '  try {',
    '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($dirs[$i], "OnlyErrorDialogs", "SendToRecycleBin")',
    '    Write-Output ("OK " + $i)',
    '  } catch {',
    '    Write-Output ("ERR " + $i + ": " + $_.Exception.Message)',
    '  }',
    '}',
    base,
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
  const withImages = !!(payload && payload.withImages)
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

  // ── 附件关联清理（可选）：解析被清理会话引用的附件，并做全库引用计数 ──
  let attachmentFiles = []
  let attachmentSkipped = []
  let attachmentInfo = undefined
  if (withImages) {
    try {
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      const attachmentsRoot = join(dshHome, 'attachments', 'v1')
      // 1) 收集被清理会话的附件 id
      const cleanedRefs = new Set()
      for (const t of targets) {
        for (const ref of attachmentIdsOfLogFile(sessionLogPath(t.dir))) cleanedRefs.add(ref)
      }
      // 2) 全库引用计数：其余（未清理）会话的日志
      const remainingRefs = new Map() // id -> count
      const allLogs = enumerateSessionLogs(join(dshHome, 'sessions'))
      const cleanedDirs = new Set(targets.map((t) => dirname(t.dir)))
      for (const log of allLogs) {
        if (cleanedDirs.has(dirname(log))) continue
        for (const ref of attachmentIdsOfLogFile(log)) {
          remainingRefs.set(ref, (remainingRefs.get(ref) || 0) + 1)
        }
      }
      // 3) 只回收“不再被任何会话引用”的附件文件
      for (const ref of cleanedRefs) {
        if ((remainingRefs.get(ref) || 0) > 0) {
          attachmentSkipped.push(ref)
          continue
        }
        const sha = ref.replace(/^sha256:/, '')
        const file = join(attachmentsRoot, 'objects', sha.slice(0, 2), sha)
        let ok = false
        try {
          if (fs) {
            const resolved = await fs.resolve(file)
            const info = await fs.stat(resolved)
            ok = info && info.type === 'file'
          } else {
            ok = statSync(file).isFile()
          }
        } catch {
          ok = false
        }
        if (ok) attachmentFiles.push(file)
      }
      attachmentInfo = { total: cleanedRefs.size, referenced: attachmentSkipped.length, orphaned: attachmentFiles.length }
    } catch (e) {
      attachmentInfo = { error: errMsg(e) }
    }
  }

  const script = buildScript(targets.map((t) => t.dir), attachmentFiles)
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

  // 附件结果：文件行号 = dirCount + index
  const attachments = { moved: [], skipped: attachmentSkipped, ...attachmentInfo }
  if (withImages) {
    for (let i = 0; i < attachmentFiles.length; i++) {
      const r = results.get(targets.length + i)
      if (r && r.ok) {
        attachments.moved.push(attachmentFiles[i])
      }
    }
  }
  return { moved, failed, skippedLive: 0, attachments }
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
