// dsh-archived-cleaner — Client half（浏览器 bundle）
//
// 本文件是预构建的客户端 bundle：以 window.__ModuleLoader__.load({ id, factory })
// 注册，由 DSH 的 client-modules 节点扫描（package.json 的 dsh.client 字段）纳入
// window.__DSH_BOOT__ 并在 /plugins/<id>/client.js 提供。
//
// UI：设置面板新增"清理归档"分区（settings.section），列出已归档会话（标题/目录/
// 大小），勾选后调用 Host RPC（/arc-cln）把所选会话目录移入 Windows 回收站。
// 运行中的会话自动置灰跳过。

window.__ModuleLoader__.load({
  id: 'dsh-archived-cleaner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    // ── 工具 ──────────────────────────────────────────────────────────────

    function fmtSize(n) {
      if (typeof n !== 'number' || n < 0) return '未知'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB'
      return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }

    function shortDir(p) {
      if (typeof p !== 'string' || !p) return ''
      return p.length > 72 ? '…' + p.slice(-72) : p
    }

    let ctxRef = null

    /** 调用 Host RPC（connection 通道 /arc-cln），失败时抛错。 */
    async function rpc(endpoint, payload) {
      const conn = ctxRef ? ctxRef.get('connection') : null
      if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
        throw new Error('connection service unavailable')
      }
      const res = await conn.rpc.call('/arc-cln', endpoint, payload || {})
      if (res && res.ok) return res.value
      throw new Error((res && res.error && res.error.message) || 'rpc failed')
    }

    // ── 清理界面 ──────────────────────────────────────────────────────────

    function CleanerPage(props) {
      const useWorkspaces = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null
      const archivedIds = useWorkspaces
        ? (useWorkspaces((s) => (s && Array.isArray(s.archivedSessionIds) ? s.archivedSessionIds : [])) || [])
        : []
      const [phase, setPhase] = React.useState('loading')
      const [items, setItems] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [withImages, setWithImages] = React.useState(true)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)

      React.useEffect(() => {
        let cancelled = false
        ;(async () => {
          setPhase('loading')
          try {
            const res = await rpc('candidates', { archivedIds })
            if (cancelled) return
            const list = res && Array.isArray(res.items) ? res.items : []
            setItems(list)
            setSelected(list.filter((it) => !it.live).map((it) => it.id))
            setPhase('pick')
          } catch (e) {
            if (cancelled) return
            setError(String((e && e.message) || e))
            setPhase('error')
          }
        })()
        return () => {
          cancelled = true
        }
      }, [reloadKey])

      async function doClean() {
        setPhase('running')
        try {
          const res = await rpc('clean', { ids: selected, withImages })
          setResult({ moved: (res && res.moved) || [], failed: (res && res.failed) || [], attachments: res && res.attachments })
          setPhase('done')
        } catch (e) {
          setError(String((e && e.message) || e))
          setPhase('error')
        }
      }

      let body = null
      if (phase === 'loading') {
        body = React.createElement('div', { className: 'arc-empty' }, '正在扫描已归档会话…')
      } else if (phase === 'error') {
        body = React.createElement('div', { className: 'arc-empty' }, '出错了：' + error)
      } else if (phase === 'pick') {
        const pickable = items.filter((it) => !it.live)
        const allChecked = pickable.length > 0 && selected.length === pickable.length
        const rows = items.map((it) => {
          const checked = selected.includes(it.id)
          return React.createElement(
            'div',
            { className: 'arc-row' + (it.live ? ' arc-row-disabled' : ''), key: it.id },
            React.createElement('input', {
              type: 'checkbox',
              checked,
              disabled: it.live,
              onChange: () => {
                setSelected((prev) =>
                  it.live ? prev : prev.includes(it.id) ? prev.filter((x) => x !== it.id) : [...prev, it.id],
                )
              },
            }),
            React.createElement(
              'div',
              { className: 'arc-row-main' },
              React.createElement('div', { className: 'arc-row-title' }, it.title || it.id),
              React.createElement('div', { className: 'arc-row-meta' }, it.dir ? shortDir(it.dir) : it.live ? '运行中' : ''),
            ),
            it.live
              ? React.createElement('span', { className: 'arc-row-live' }, '运行中 · 跳过')
              : React.createElement('span', { className: 'arc-size' }, fmtSize(it.size)),
          )
        })
        body = React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { className: 'arc-note' },
            '共 ' + items.length + ' 个已归档会话，将移入 Windows 回收站（可恢复）；运行中的会话不会受影响。',
          ),
          React.createElement(
            'label',
            { className: 'arc-select-all' },
            React.createElement('input', {
              type: 'checkbox',
              checked: withImages,
              onChange: (e) => setWithImages(e.target.checked),
            }),
            ' 同时清理仅被这些会话引用的图片（附件）——仍被其他会话使用的图片会自动跳过',
          ),
          pickable.length > 0
            ? React.createElement(
                'label',
                { className: 'arc-select-all' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: allChecked,
                  onChange: () => setSelected(allChecked ? [] : pickable.map((it) => it.id)),
                }),
                ' 全选',
              )
            : null,
          rows.length > 0
            ? React.createElement('div', { className: 'arc-list' }, rows)
            : React.createElement('div', { className: 'arc-empty' }, '没有可清理的已归档会话'),
        )
      } else if (phase === 'running') {
        body = React.createElement('div', { className: 'arc-empty' }, '正在移入回收站…')
      } else if (phase === 'done') {
        const failedRows = (result.failed || []).map((f) =>
          React.createElement('div', { className: 'arc-fail', key: f.id }, f.id + '：' + (f.error || '未知错误')),
        )
        const att = result.attachments
        let attLine = null
        if (att && att.total !== undefined) {
          attLine = React.createElement(
            'div',
            { className: 'arc-note' },
            '关联图片：共 ' +
              att.total +
              ' 张被引用，已清理 ' +
              ((att.moved || []).length) +
              ' 张' +
              (att.referenced ? '，跳过 ' + att.referenced + ' 张（仍被其他会话使用）' : '') +
              (att.error ? '（附件扫描出错：' + att.error + '）' : ''),
          )
        }
        body = React.createElement(
          'div',
          null,
          React.createElement(
            'div',
            { className: 'arc-empty' },
            '已移入回收站 ' +
              (result.moved || []).length +
              ' 个会话' +
              (result.failed && result.failed.length ? '，失败 ' + result.failed.length + ' 个' : ''),
          ),
          attLine,
          failedRows.length ? React.createElement('div', { className: 'arc-fail-list' }, failedRows) : null,
        )
      }
      const foot = React.createElement(
        'div',
        { className: 'arc-page-foot' },
        React.createElement(
          'button',
          {
            className: 'arc-btn2',
            type: 'button',
            disabled: phase === 'loading' || phase === 'running',
            onClick: () => setReloadKey((k) => k + 1),
          },
          '刷新',
        ),
        phase === 'pick'
          ? React.createElement(
              'button',
              {
                className: 'arc-btn2 arc-btn-primary',
                type: 'button',
                disabled: selected.length === 0,
                onClick: doClean,
              },
              '移入回收站 (' + selected.length + ')',
            )
          : null,
      )
      return React.createElement(
        'div',
        { className: 'arc-page' },
        React.createElement('div', { className: 'arc-page-title' }, '清理归档记录'),
        React.createElement('div', { className: 'arc-page-body' }, body),
        foot,
      )
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────

    const CSS =
      '.arc-page{padding:2px 2px 8px}.arc-page-title{font-weight:600;font-size:14px;padding:6px 2px 2px}.arc-page-body{min-height:120px}.arc-note{color:var(--dsw-alias-label-secondary,#a0a2b0);font-size:12px;margin:8px 0 10px;line-height:1.5}.arc-select-all{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#a0a2b0);padding:4px 2px;cursor:pointer}.arc-list{border-top:1px solid var(--dsw-alias-border,#262730);max-height:46vh;overflow:auto}.arc-row{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--dsw-alias-border,#262730)}.arc-row-disabled{opacity:.55}.arc-row-main{flex:1;min-width:0}.arc-row-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.arc-row-meta{color:var(--dsw-alias-label-tertiary,#70718a);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.arc-row-live{flex:none;color:#d9a13b;font-size:11px;white-space:nowrap}.arc-size{flex:none;color:var(--dsw-alias-label-secondary,#a0a2b0);font-size:12px;min-width:70px;text-align:right;white-space:nowrap}.arc-empty{color:var(--dsw-alias-label-secondary,#a0a2b0);padding:20px 4px;text-align:center;line-height:1.6}.arc-page-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 2px 4px}.arc-btn2{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border,#33343f);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e8e8ef);padding:6px 14px;font-size:13px}.arc-btn2:hover:not(:disabled){background:rgba(255,255,255,.12)}.arc-btn2:disabled{cursor:default;opacity:.5}.arc-btn-primary{background:var(--dsw-accent,#5b8cff);border-color:transparent;color:#fff}.arc-fail-list{margin:0 0 12px}.arc-fail{color:#e06c75;font-size:12px;padding:3px 4px;word-break:break-all}'

    function apply(ctx) {
      ctxRef = ctx
      // 注入样式并随插件卸载自动移除。
      ctx.effect(() => {
        const el = document.createElement('style')
        el.id = 'dsh-arc-css'
        el.textContent = CSS
        document.head.appendChild(el)
        return () => {
          el.remove()
        }
      })
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'archived-cleaner', order: 30, label: () => '清理归档' },
          (props) => React.createElement(CleanerPage, { props }),
        ),
      )
    }

    exports.name = 'archived-cleaner'
    exports.apply = apply
    return module.exports
  },
})
