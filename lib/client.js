// dsh-price-mixer — browser half.
//
// A sidebar panel ("价格") listing every agent2api model with its effective
// price and where that price came from:
//   manual  — you typed it (saved to ~/.dsh/price-mixer.json)
//   derived — copied live from the canonical models.dev entry
//   none    — no source; type one in to price it
//
// Saving writes the config file through the host half's API, so it survives
// restarts and never touches plugin sources. Note: dsh-context caches the price
// book for an hour, so a change lands on its next book fetch (or a restart) —
// that cache is upstream behaviour and we do not patch it.
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

      var CSS = [
        '.pmx-shell{display:flex;flex-direction:column;width:100%;box-sizing:border-box;height:100%;',
        '  min-height:calc(100dvh - 96px);color:var(--dsw-alias-label-primary,inherit);}',
        '.pmx-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:none;',
        '  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));font-size:12.5px;}',
        '.pmx-t{font-weight:600;white-space:nowrap;}',
        '.pmx-s{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));font-size:11.5px;',
        '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pmx-r{margin-left:auto;display:flex;gap:6px;flex:none;}',
        '.pmx-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
        '  background:transparent;color:inherit;border-radius:8px;padding:3px 10px;font-size:12px;',
        '  cursor:pointer;line-height:1.6;white-space:nowrap;}',
        '.pmx-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));}',
        '.pmx-btn[disabled]{opacity:.45;cursor:default;}',
        '.pmx-body{flex:1 1 auto;overflow:auto;padding:10px 14px 24px;}',
        '.pmx-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));',
        '  padding:8px 10px;margin-bottom:10px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));}',
        '.pmx-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;',
        '  padding:8px 10px;margin-bottom:8px;}',
        '.pmx-head{display:flex;align-items:center;gap:8px;font-size:12.5px;}',
        '.pmx-id{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}',
        '.pmx-tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.85;}',
        '.pmx-tag.manual{color:#c07a00;}',
        '.pmx-tag.derived{color:#2f8f5b;}',
        '.pmx-tag.fuzzy{color:#2f7f9a;}',
        '.pmx-tag.none{color:#b04a4a;}',
        '.pmx-src{margin-left:auto;font-size:10.5px;opacity:.6;overflow:hidden;text-overflow:ellipsis;',
        '  white-space:nowrap;max-width:46%;}',
        '.pmx-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:6px;}',
        '.pmx-cell{display:flex;flex-direction:column;gap:2px;}',
        '.pmx-lb{font-size:10px;opacity:.55;}',
        '.pmx-in{width:100%;box-sizing:border-box;font-size:12px;padding:3px 6px;border-radius:6px;',
        '  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;',
        '  color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
        '.pmx-acts{display:flex;gap:6px;margin-top:7px;}',
        '.pmx-err{color:#b04a4a;font-size:11.5px;margin-top:4px;}',
        '@media (max-width:720px){.pmx-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}',
      ].join('')

      function fmt(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return ''
        return String(Math.round(value * 100000) / 100000)
      }

      function tagText(source) {
        if (source === 'manual') return '手填'
        if (source === 'derived') return '派生'
        if (source === 'fuzzy') return '模糊'
        return '无价'
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

      function Row(props) {
        var row = props.row
        var [draft, setDraft] = useState(function () { return draftOf(row) })
        var [busy, setBusy] = useState(false)
        var [error, setError] = useState('')

        useEffect(function () { setDraft(draftOf(row)) }, [row.id, row.source, row.input, row.output, row.cache_read, row.cache_write])

        function draftOf(r) {
          var out = {}
          for (var i = 0; i < FIELDS.length; i += 1) out[FIELDS[i]] = fmt(r[FIELDS[i]])
          return out
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
          setError('')
          setBusy(true)
          fetch(API + '/override', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).then(function (r) { return r.json() }).then(function (data) {
            setBusy(false)
            if (!data.ok) { setError(data.error || '保存失败'); return }
            props.onChanged(data.models)
          }).catch(function (e) { setBusy(false); setError(String((e && e.message) || e)) })
        }

        function reset() {
          setError('')
          setBusy(true)
          fetch(API + '/reset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: row.id }),
          }).then(function (r) { return r.json() }).then(function (data) {
            setBusy(false)
            if (!data.ok) { setError(data.error || '恢复失败'); return }
            props.onChanged(data.models)
          }).catch(function (e) { setBusy(false); setError(String((e && e.message) || e)) })
        }

        return h('div', { className: 'pmx-row' }, [
          h('div', { className: 'pmx-head', key: 'hd' }, [
            h('span', { className: 'pmx-id', key: 'id' }, row.id),
            h('span', { className: 'pmx-tag ' + row.source, key: 'tg' }, tagText(row.source)),
            row.canonical ? h('span', { className: 'pmx-src', key: 'sc', title: '派生自 ' + row.canonical }, '← ' + row.canonical) : null,
          ]),
          h('div', { className: 'pmx-grid', key: 'gd' }, FIELDS.map(function (f) {
            return h('label', { className: 'pmx-cell', key: f }, [
              h('span', { className: 'pmx-lb', key: 'lb' }, LABEL[f] + ' $/M'),
              h('input', {
                key: 'in', className: 'pmx-in', inputMode: 'decimal', value: draft[f] === undefined ? '' : draft[f],
                placeholder: f === 'input' || f === 'output' ? '必填' : '默认=输入',
                onChange: (function (field) {
                  return function (event) {
                    var next = { ...draft }
                    next[field] = event.target.value
                    setDraft(next)
                  }
                })(f),
              }),
            ])
          })),
          h('div', { className: 'pmx-acts', key: 'ac' }, [
            h('button', { key: 'sv', className: 'pmx-btn', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h('button', {
              key: 'rs', className: 'pmx-btn', disabled: busy || row.source !== 'manual', onClick: reset,
            }, '恢复派生'),
          ]),
          error ? h('div', { className: 'pmx-err', key: 'er' }, error) : null,
        ])
      }

      function Panel() {
        var [rows, setRows] = useState([])
        var [configFile, setConfigFile] = useState('')
        var [bookSeen, setBookSeen] = useState(false)
        var [bookLoading, setBookLoading] = useState(false)
        var [bookError, setBookError] = useState('')
        var [error, setError] = useState('')
        var [loading, setLoading] = useState(true)
        var tries = useRef(0)

        // The host loads the price book in the background (6MB, sometimes slow)
        // and answers at once, so we poll while it says "loading". This is what
        // stops a freshly restarted host from showing every model as unpriced.
        var load = useCallback(function (force) {
          setLoading(true)
          var request = force
            ? fetch(API + '/reload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            : fetch(API + '/models')
          request.then(function (r) { return r.json() }).then(function (data) {
            setLoading(false)
            if (!data.ok) { setError(data.error || '读取失败'); return }
            setError('')
            setRows(data.models || [])
            setConfigFile(data.configFile || '')
            setBookSeen(data.bookSeen === true)
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

        var clearAll = useCallback(function () {
          fetch(API + '/reset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ all: true }),
          }).then(function (r) { return r.json() }).then(function (data) {
            if (data.ok) changed(data.models)
          }).catch(function () { /* keep the old view */ })
        }, [changed])

        var manualCount = rows.filter(function (r) { return r.source === 'manual' }).length
        var noneCount = rows.filter(function (r) { return r.source === 'none' }).length

        return h('div', { className: 'pmx-shell' }, [
          h('div', { className: 'pmx-bar', key: 'bar' }, [
            h('span', { className: 'pmx-t', key: 't' }, '价格影子'),
            h('span', { className: 'pmx-s', key: 's' }, loading ? '读取中…' : (rows.length + ' 个模型 · 手填 ' + manualCount + ' · 无价 ' + noneCount)),
            h('div', { className: 'pmx-r', key: 'r' }, [
              h('button', { key: 'rf', className: 'pmx-btn', onClick: function () { load(false) }, disabled: loading }, '刷新'),
              h('button', { key: 'rl', className: 'pmx-btn', onClick: function () { tries.current = 3; load(true) }, disabled: loading }, '重读价格簿'),
              h('button', { key: 'cl', className: 'pmx-btn', onClick: clearAll, disabled: loading || manualCount === 0 }, '清空手填'),
            ]),
          ]),
          h('div', { className: 'pmx-body', key: 'body' }, [
            h('div', { className: 'pmx-note', key: 'note' }, [
              h('div', { key: 'n1' }, '这些是给 agent2api 反代模型用的“影子价”，只影响 dsh-context 面板里的 Est. Cost 估算，不涉及真实扣费。'),
              h('div', { key: 'n2' }, '手填优先于自动派生；留空则回落到派生价。保存写入 ' + (configFile || '~/.dsh/price-mixer.json') + '，重启不丢。'),
              h('div', { key: 'n3' }, bookError
                ? '价格簿读取失败：' + bookError + '（点「重读价格簿」重试；已保存的手填价不受影响）'
                : (bookLoading
                  ? '正在读价格簿…（几秒后派生价会出现，也可先手填）'
                  : (bookSeen
                    ? 'dsh-context 自己缓存价格簿 1 小时：改完在下一次取价或重启后生效。'
                    : '点「重读价格簿」拉取权威价格簿，或直接手填。'))),
            ]),
            error ? h('div', { className: 'pmx-err', key: 'err' }, error) : null,
            loading && rows.length === 0 ? h('div', { className: 'pmx-note', key: 'ld' }, '读取中…') : null,
            rows.map(function (row) { return h(Row, { key: row.id, row: row, onChanged: changed }) }),
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
