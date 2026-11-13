// dsh-price-mixer — browser half (0.3.0).
//
// A panel ("价格影子") listing every model the host is actually configured with
// (read from cordis.patch.yml, no gateway request, no API key) together with the
// price the matcher chose and *why*:
//
//   精确 (auto)      — name matched exactly: family + version + tier
//   档位 (auto-tier) — the version only ships with one tier in the book
//   估价 (estimate)  — no official vendor quote; the most common gateway price
//   待定 (pending)   — the match is not good enough; pick one of the candidates
//   别名 (alias)     — you pinned a book entry for this id
//   手填 (manual)    — you typed the four numbers yourself
//   无价 (none)      — nothing plausible in the book
//
// Nothing is guessed silently: a pending row injects no price until you click a
// candidate. Every write goes through the host API into ~/.dsh/price-mixer.json,
// so it survives restarts and never touches plugin sources.
try {
  window.__ModuleLoader__.load({
    id: 'dsh-price-mixer',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      var React = null
      try { React = require('react') } catch (e) { /* fallback below */ }
      if (!React) React = globalThis.React
      if (!React) throw new Error('dsh-price-mixer: React runtime unavailable')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useCallback = React.useCallback
      var useRef = React.useRef

      var PANEL_ID = 'price-mixer'
      var API = '/price-mixer'
      var FIELDS = ['input', 'output', 'cache_read', 'cache_write']
      var LABEL = { input: '输入', output: '输出', cache_read: '缓存读', cache_write: '缓存写' }

      var TAG = {
        manual: '手填', alias: '别名', auto: '精确', estimate: '估价', 'auto-tier': '档位',
        'ver-estimate': '版本估', 'fam-estimate': '家族估',
        pending: '待定', none: '无价', waiting: '读价中', 'alias-stale': '别名失效', 'alias-none': '已排除',
      }
      // statuses that carry a price but were inferred rather than quoted
      var ESTIMATED = { estimate: 1, 'auto-tier': 1, 'ver-estimate': 1, 'fam-estimate': 1 }
      var PINNED = { manual: 1, alias: 1, 'alias-none': 1 }

      var CSS = [
        '.pmx-shell{display:flex;flex-direction:column;width:100%;box-sizing:border-box;height:100%;',
        '  min-height:calc(100dvh - 96px);color:var(--dsw-alias-label-primary,inherit);}',
        '.pmx-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:none;flex-wrap:wrap;',
        '  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));font-size:12.5px;}',
        '.pmx-t{font-weight:600;white-space:nowrap;}',
        '.pmx-s{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));font-size:11.5px;',
        '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pmx-r{margin-left:auto;display:flex;gap:6px;flex:none;flex-wrap:wrap;}',
        '.pmx-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
        '  background:transparent;color:inherit;border-radius:8px;padding:3px 10px;font-size:12px;',
        '  cursor:pointer;line-height:1.6;white-space:nowrap;}',
        '.pmx-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));}',
        '.pmx-btn[disabled]{opacity:.45;cursor:default;}',
        '.pmx-btn.mini{padding:1px 8px;font-size:11.5px;border-radius:999px;}',
        '.pmx-body{flex:1 1 auto;overflow:auto;padding:10px 14px 24px;}',
        '.pmx-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));',
        '  padding:8px 10px;margin-bottom:10px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));}',
        '.pmx-note b{font-weight:600;color:var(--dsw-alias-label-primary,inherit);}',
        '.pmx-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;',
        '  padding:8px 10px;margin-bottom:8px;}',
        '.pmx-row.pending{border-color:rgba(192,122,0,.45);}',
        '.pmx-head{display:flex;align-items:center;gap:8px;font-size:12.5px;flex-wrap:wrap;}',
        '.pmx-id{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}',
        '.pmx-tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.9;flex:none;}',
        '.pmx-tag.manual{color:#c07a00;}',
        '.pmx-tag.alias{color:#7a4fc0;}',
        '.pmx-tag.auto{color:#2f8f5b;}',
        '.pmx-tag.estimate{color:#2f7f9a;}',
        '.pmx-tag.auto-tier{color:#3f7fa8;}',
        '.pmx-tag.ver-estimate{color:#5a7fbf;}',
        '.pmx-tag.fam-estimate{color:#8a7ab8;}',
        '.pmx-tag.pending{color:#c07a00;}',
        '.pmx-tag.none,.pmx-tag.waiting,.pmx-tag.alias-stale{color:#b04a4a;}',
        '.pmx-tag.alias-none{color:#7a7a7a;}',
        '.pmx-src{margin-left:auto;font-size:10.5px;opacity:.62;overflow:hidden;text-overflow:ellipsis;',
        '  white-space:nowrap;max-width:52%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
        '.pmx-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:6px;}',
        '.pmx-cell{display:flex;flex-direction:column;gap:2px;}',
        '.pmx-lb{font-size:10px;opacity:.55;}',
        '.pmx-in{width:100%;box-sizing:border-box;font-size:12px;padding:3px 6px;border-radius:6px;',
        '  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;',
        '  color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
        '.pmx-acts{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap;}',
        '.pmx-why{font-size:10.5px;opacity:.6;margin-top:5px;line-height:1.6;}',
        '.pmx-cands{margin-top:7px;display:flex;flex-direction:column;gap:4px;}',
        '.pmx-cand{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:3px 6px;border-radius:7px;',
        '  background:var(--dsw-alias-bg-l2,rgba(127,127,127,.06));}',
        '.pmx-cand-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;',
        '  text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;}',
        '.pmx-cand-p{font-variant-numeric:tabular-nums;opacity:.75;flex:none;}',
        '.pmx-cand>.pmx-btn{flex:none;}',
        '.pmx-err{color:#b04a4a;font-size:11.5px;margin-top:4px;}',
        '@media (max-width:720px){.pmx-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}',
      ].join('')

      function fmt(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return ''
        return String(Math.round(value * 100000) / 100000)
      }

      function postJSON(path, body) {
        return fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json() })
      }

      function PriceIcon(props) {
        var size = (props && props.size) || 20
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
          style: { flex: 'none' },
        }, [
          h('path', { key: 'a', d: 'M12 4.5v15' }),
          h('path', { key: 'b', d: 'M16.2 8.2c-.7-1.3-2.3-2-4.2-2-2.4 0-4 1-4 2.6 0 1.8 1.9 2.4 4.1 2.9 2.3.5 4.1 1.2 4.1 3 0 1.7-1.7 2.8-4.2 2.8-2.1 0-3.7-.8-4.4-2.2' }),
        ])
      }

      function draftOf(row) {
        var out = {}
        for (var i = 0; i < FIELDS.length; i += 1) out[FIELDS[i]] = fmt(row[FIELDS[i]])
        return out
      }

      function Row(props) {
        var row = props.row
        var [draft, setDraft] = useState(function () { return draftOf(row) })
        var [busy, setBusy] = useState(false)
        var [error, setError] = useState('')
        var [open, setOpen] = useState(row.status === 'pending')

        useEffect(function () { setDraft(draftOf(row)) }, [row.id, row.status, row.input, row.output, row.cache_read, row.cache_write])
        useEffect(function () { if (row.status === 'pending') setOpen(true) }, [row.status])

        function run(promise) {
          setError('')
          setBusy(true)
          return promise.then(function (data) {
            setBusy(false)
            if (!data.ok) { setError(data.error || '操作失败'); return }
            props.onChanged(data.models)
          }).catch(function (e) { setBusy(false); setError(String((e && e.message) || e)) })
        }

        function save() {
          var body = { model: row.id }
          for (var i = 0; i < FIELDS.length; i += 1) {
            var f = FIELDS[i]
            var v = draft[f]
            if (v === '' || v === undefined) continue
            var n = Number(v)
            if (!Number.isFinite(n) || n < 0) { setError('数值不合法：' + LABEL[f]); return }
            body[f] = n
          }
          if (body.input === undefined || body.output === undefined) { setError('输入、输出单价必填'); return }
          run(postJSON('/override', body))
        }

        function clearManual() { run(postJSON('/reset', { model: row.id })) }
        function pin(canonical) { run(postJSON('/alias', { model: row.id, canonical: canonical })) }
        function unpin() { run(postJSON('/alias', { model: row.id, canonical: null })) }

        var pinned = PINNED[row.status] === 1
        var candidates = row.candidates || []
        var canPick = ESTIMATED[row.status] === 1 || row.status === 'pending' || row.status === 'none'
        var source = row.canonical || (row.status === 'manual' ? '手填价' : '')

        return h('div', { className: 'pmx-row' + (row.status === 'pending' ? ' pending' : '') }, [
          h('div', { className: 'pmx-head', key: 'hd' }, [
            h('span', { className: 'pmx-id', key: 'id' }, row.id),
            h('span', { className: 'pmx-tag ' + row.status, key: 'tg' }, TAG[row.status] || row.status),
            row.provider ? h('span', { className: 'pmx-src', key: 'pv', title: '用途：配置里的供应商 ' + row.provider }, row.provider) : null,
            source ? h('span', { className: 'pmx-src', key: 'sc', title: source }, '← ' + source) : null,
          ]),
          h('div', { className: 'pmx-grid', key: 'gd' }, FIELDS.map(function (f) {
            return h('label', { className: 'pmx-cell', key: f }, [
              h('span', { className: 'pmx-lb', key: 'lb' }, LABEL[f] + ' $/M'),
              h('input', {
                key: 'in', className: 'pmx-in', inputMode: 'decimal', value: draft[f] === undefined ? '' : draft[f],
                placeholder: f === 'input' || f === 'output' ? '必填' : '默认=输入',
                onChange: (function (field) {
                  return function (event) {
                    var next = {}
                    for (var k in draft) next[k] = draft[k]
                    next[field] = event.target.value
                    setDraft(next)
                  }
                })(f),
              }),
            ])
          })),
          h('div', { className: 'pmx-acts', key: 'ac' }, [
            h('button', { key: 'sv', className: 'pmx-btn', disabled: busy, onClick: save }, busy ? '保存中…' : '手填保存'),
            row.status === 'manual' ? h('button', { key: 'rs', className: 'pmx-btn', disabled: busy, onClick: clearManual }, '撤销手填') : null,
            pinned ? h('button', { key: 'un', className: 'pmx-btn', disabled: busy, onClick: unpin }, '解除固定') : null,
            canPick && candidates.length > 0
              ? h('button', { key: 'op', className: 'pmx-btn', onClick: function () { setOpen(!open) } }, open ? '收起候选' : ('候选 ' + candidates.length))
              : null,
            row.status === 'pending' || row.status === 'none'
              ? h('button', { key: 'ex', className: 'pmx-btn', disabled: busy, onClick: function () { pin(null) } }, '标记免费/无价')
              : null,
          ]),
          row.reason ? h('div', { className: 'pmx-why', key: 'why' }, row.reason + (row.score != null ? '（得分 ' + row.score + '）' : '')) : null,
          open && candidates.length > 0 ? h('div', { className: 'pmx-cands', key: 'cd' }, candidates.map(function (cand) {
            return h('div', { className: 'pmx-cand', key: cand.canonical }, [
              h('span', { className: 'pmx-cand-id', key: 'c', title: (cand.reasons || []).join(' ') }, cand.canonical),
              h('span', { className: 'pmx-cand-p', key: 'p' }, fmt(cand.input) + ' / ' + fmt(cand.output)),
              h('span', { className: 'pmx-cand-p', key: 's', title: '匹配得分' }, String(cand.score)),
              h('button', { key: 'u', className: 'pmx-btn mini', disabled: busy, onClick: function () { pin(cand.canonical) } }, '采用'),
            ])
          })) : null,
          error ? h('div', { className: 'pmx-err', key: 'er' }, error) : null,
        ])
      }

      function Panel() {
        var [rows, setRows] = useState([])
        var [configFile, setConfigFile] = useState('')
        var [bookSeen, setBookSeen] = useState(false)
        var [bookLoading, setBookLoading] = useState(false)
        var [bookError, setBookError] = useState('')
        var [discovery, setDiscovery] = useState(null)
        var [error, setError] = useState('')
        var [loading, setLoading] = useState(true)
        var [filter, setFilter] = useState('all')
        var tries = useRef(0)

        // The host loads the price book in the background (6MB, sometimes slow)
        // and answers at once, so we poll while it says "loading". This is what
        // stops a freshly restarted host from showing every model as unpriced.
        var load = useCallback(function (force) {
          setLoading(true)
          var request = force
            ? postJSON('/reload', {})
            : fetch(API + '/models').then(function (r) { return r.json() })
          request.then(function (data) {
            setLoading(false)
            if (!data.ok) { setError(data.error || '读取失败'); return }
            setError('')
            setRows(data.models || [])
            setConfigFile(data.configFile || '')
            setBookSeen(data.bookSeen === true)
            setDiscovery(data.discovery || null)
            var meta = data.book || {}
            setBookLoading(meta.loading === true)
            setBookError(meta.error || '')
            var waiting = data.bookSeen !== true && meta.loading === true
            if (waiting && tries.current < 20) {
              tries.current += 1
              setTimeout(function () { load(false) }, 2000)
            }
          }).catch(function (e) { setLoading(false); setError(String((e && e.message) || e)) })
        }, [])

        useEffect(function () { load() }, [load])

        var changed = useCallback(function (next) {
          setRows(next || [])
          setBookSeen(true)
        }, [])

        var rescan = useCallback(function () {
          postJSON('/rescan', {}).then(function (data) {
            if (!data.ok) return
            setRows(data.models || [])
            setDiscovery(data.discovery || null)
          }).catch(function () { /* keep the old view */ })
        }, [])

        var clearAll = useCallback(function () {
          postJSON('/reset', { all: true }).then(function (data) {
            if (data.ok) changed(data.models)
          }).catch(function () { /* keep the old view */ })
        }, [changed])

        function count(status) { return rows.filter(function (r) { return r.status === status }).length }
        var needClick = count('pending')
        var unpriced = count('none') + count('waiting')
        var manualCount = count('manual')
        var pinnedCount = count('alias') + count('alias-none') + count('alias-stale')
        var exactCount = count('auto')
        var estCount = rows.filter(function (r) { return ESTIMATED[r.status] === 1 }).length

        var shown = rows.filter(function (r) {
          if (filter === 'all') return true
          if (filter === 'todo') return r.status === 'pending' || r.status === 'none' || r.status === 'waiting'
          if (filter === 'est') return ESTIMATED[r.status] === 1
          if (filter === 'pinned') return PINNED[r.status] === 1
          return r.status === filter
        })

        var files = (discovery && discovery.files) || []
        var used = files.filter(function (f) { return f.exists && f.models > 0 })
        var sourceText = discovery
          ? (discovery.fallback
            ? '未在配置里找到供应商，正在用内置兜底清单'
            : used.map(function (f) { return f.path.replace(/^.*[\\/]/, '') + '（' + f.providers + ' 供应商 / ' + f.models + ' 模型）' }).join(' + '))
          : '读取配置中…'

        var seg = function (key, label) {
          return h('button', {
            key: key, className: 'pmx-btn mini',
            style: filter === key ? { borderColor: 'currentColor', fontWeight: 600 } : null,
            onClick: function () { setFilter(key) },
          }, label)
        }

        return h('div', { className: 'pmx-shell' }, [
          h('div', { className: 'pmx-bar', key: 'bar' }, [
            h('span', { className: 'pmx-t', key: 't' }, '价格影子'),
            h('span', {
              className: 'pmx-s', key: 's',
              title: '模型清单来自本机 DSH 配置；价格来自 models.dev 公开价格簿',
            }, loading && rows.length === 0
              ? '读取中…'
              : (rows.length + ' 个模型 · 精确 ' + exactCount + ' · 估价 ' + estCount
                + ' · 待定 ' + needClick + ' · 无价 ' + unpriced
                + (pinnedCount ? ' · 固定 ' + pinnedCount : '') + (manualCount ? ' · 手填 ' + manualCount : ''))),
            h('div', { className: 'pmx-r', key: 'r' }, [
              h('button', { key: 'rf', className: 'pmx-btn', onClick: function () { load(false) }, disabled: loading }, '刷新'),
              h('button', { key: 'rs', className: 'pmx-btn', onClick: rescan, disabled: loading }, '重扫配置'),
              h('button', { key: 'rl', className: 'pmx-btn', onClick: function () { tries.current = 3; load(true) }, disabled: loading }, '重读价格簿'),
              h('button', { key: 'cl', className: 'pmx-btn', onClick: clearAll, disabled: loading || manualCount === 0 }, '清空手填'),
            ]),
          ]),
          h('div', { className: 'pmx-body', key: 'body' }, [
            h('div', { className: 'pmx-note', key: 'note' }, [
              h('div', { key: 'n1' }, '这些是给本机反代模型用的“影子价”，只影响 dsh-context 面板里的 Est. Cost 估算，不涉及真实扣费。'),
              h('div', { key: 'n2' }, ['模型清单：', h('b', { key: 'b2' }, sourceText), '（只读配置，不请求网关、不用密钥）']),
              h('div', { key: 'n3' }, ['价格：', h('b', { key: 'b3' }, '精确'), ' = 名称完全对上；', h('b', { key: 'b4' }, '档位'), ' = 该书里只有这一档；', h('b', { key: 'b5' }, '估价'), ' = 官方没报价时的常见价；', h('b', { key: 'b5a' }, '版本估'), ' = 版本对上但没有同档，按该版本最常见的档；', h('b', { key: 'b5b' }, '家族估'), ' = 只认出家族，按最接近的版本粗估；', h('b', { key: 'b6' }, '待定'), ' = 没把握，等你点一个候选（点了就固定成别名）。']),
              h('div', { key: 'n4' }, bookError
                ? '价格簿读取失败：' + bookError + '（点「重读价格簿」重试；已保存的手填价/别名不受影响）'
                : (bookLoading
                  ? '正在读价格簿…（几秒后自动价会出现，也可先手填）'
                  : (bookSeen
                    ? 'dsh-context 自己缓存价格簿 1 小时：改完在下一次取价或重启后生效。写入 ' + (configFile || '~/.dsh/price-mixer.json')
                    : '点「重读价格簿」拉取权威价格簿，或直接手填。'))),
            ]),
            error ? h('div', { className: 'pmx-err', key: 'err' }, error) : null,
            h('div', { className: 'pmx-acts', key: 'ft' }, [
              seg('all', '全部'),
              seg('todo', '待处理'),
              seg('est', '估价 ' + estCount),
              seg('pinned', '已固定'),
              seg('auto', '精确 ' + exactCount),
            ]),
            loading && rows.length === 0 ? h('div', { className: 'pmx-note', key: 'ld' }, '读取中…') : null,
            shown.map(function (row) { return h(Row, { key: row.provider + '::' + row.id, row: row, onChanged: changed }) }),
            rows.length > 0 && shown.length === 0 ? h('div', { className: 'pmx-note', key: 'empty' }, '这个筛选下没有模型。') : null,
          ]),
        ])
      }

      function apply(ctx) {
        var styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-price-mixer', '')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        ctx.effect(function () {
          return function () { styleEl.remove() }
        }, 'dsh-price-mixer: styles')

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 26,
            label: function () { return '价格影子' },
          }, PriceIcon)
        })
      }

      exports.apply = apply
      exports.inject = ['slots']
      return module.exports
    },
  })
} catch (error) {
  var msg = String((error && error.message) || error)
  if (!/duplicate factory registration/.test(msg)) throw error
}
