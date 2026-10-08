import { useEffect, useMemo, useState } from 'react'
import { CONNECTION_PRESETS, modelLabel, presetOf, type Connection, type ProviderConfig } from '@shared/llm'
import { ATTRIBUTES, type BenchCheck, type BenchmarkReport } from '@shared/benchmark'
import { api, useApp } from '@/state/app'
import { useBench } from '@/state/bench'
import { CompareModels } from './CompareModels'

const pct = (x: number) => `${Math.round(x * 100)}%`
const uidOf = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/**
 * Models page. A connection is one provider account (one API key); under it you
 * pick which of its models to use. Benchmarks and the tutor work per model.
 */
export function ModelsView() {
  const settings = useApp((s) => s.settings)
  const { saveConfig } = useApp.getState()
  const [justAdded, setJustAdded] = useState<string | null>(null)

  const addConnection = async (presetId: string) => {
    const pre = CONNECTION_PRESETS.find((p) => p.id === presetId)!
    const c: Connection = { id: uidOf('cx'), preset: pre.id, label: pre.label, kind: pre.kind, baseUrl: pre.baseUrl }
    // Start with the recommended model so there is something to use right away.
    const first = pre.suggested[0]
    const providers = first
      ? [...settings.providers, { id: uidOf('pv'), label: first.label, connectionId: c.id, kind: c.kind, baseUrl: c.baseUrl, model: first.model }]
      : settings.providers
    await saveConfig({ connections: [...settings.connections, c], providers })
    setJustAdded(c.id)
  }

  const used = new Set(settings.connections.map((c) => c.preset))

  return (
    <div className="page">
      <h2>Models</h2>
      <p className="muted">
        Connect a provider once with its API key, then choose any of its models. One Anthropic key covers every Claude model, one Google key every Gemini
        model. Keys are encrypted with your OS keychain and only sent to that provider.
      </p>

      <div className="connections">
        {settings.connections.length === 0 && <div className="muted">No connections yet. Add one below.</div>}
        {settings.connections.map((c) => (
          <ConnectionCard key={c.id} c={c} startOpen={justAdded === c.id} />
        ))}
      </div>

      <div className="add-presets">
        <span>Add a connection:</span>
        {CONNECTION_PRESETS.filter((p) => p.id === 'custom' || !used.has(p.id)).map((p) => (
          <button key={p.id} onClick={() => addConnection(p.id)} title={p.hint}>+ {p.label}</button>
        ))}
      </div>

      <CompareModels />
    </div>
  )
}

function ConnectionCard({ c, startOpen }: { c: Connection; startOpen: boolean }) {
  const settings = useApp((s) => s.settings)
  const { saveConfig } = useApp.getState()
  const pre = presetOf(c)
  const models = settings.providers.filter((p) => p.connectionId === c.id)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? '')
  const [available, setAvailable] = useState<string[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [picking, setPicking] = useState(startOpen && models.length === 0)
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  const running = useBench((s) => s.running)
  const ready = c.hasKey || !pre.needsKey

  const loadModels = async () => {
    setLoadErr(null)
    try {
      const all = await api().llm.models(c.id)
      setAvailable(all.filter((m) => !pre.filter || !pre.filter.test(m)))
    } catch (e) {
      setAvailable(null)
      setLoadErr((e as Error).message)
    }
  }
  useEffect(() => {
    if (ready) loadModels()
  }, [c.id, c.hasKey, c.baseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async () => {
    if (!key.trim()) return
    await api().keys.set(c.id, key.trim())
    setKey('')
    await saveConfig({})
  }
  const saveUrl = async () => {
    await saveConfig({ connections: settings.connections.map((x) => (x.id === c.id ? { ...x, baseUrl: baseUrl.trim() || undefined } : x)) })
  }
  const removeConnection = async () => {
    if (!window.confirm(`Remove ${c.label} and its ${models.length} model(s)? The key is deleted. Benchmark results are kept for comparison.`)) return
    await api().keys.set(c.id, null)
    await saveConfig({ connections: settings.connections.filter((x) => x.id !== c.id), providers: settings.providers.filter((p) => p.connectionId !== c.id) })
  }

  const has = (m: string) => models.some((p) => p.model === m)
  const toggleModel = async (m: string) => {
    if (has(m)) {
      await saveConfig({ providers: settings.providers.filter((p) => !(p.connectionId === c.id && p.model === m)) })
    } else {
      const p: ProviderConfig = { id: uidOf('pv'), label: modelLabel(c, m), connectionId: c.id, kind: c.kind, baseUrl: c.baseUrl, model: m }
      await saveConfig({ providers: [...settings.providers, p] })
    }
  }

  // Picker list: suggested first, then everything the key can use.
  const pickList = useMemo(() => {
    const sug = pre.suggested.map((s) => s.model)
    const rest = (available ?? []).filter((m) => !sug.includes(m)).sort()
    const all = [...sug.filter((m) => !available || available.includes(m) || has(m)), ...rest]
    for (const p of models) if (!all.includes(p.model)) all.push(p.model)
    const f = filter.trim().toLowerCase()
    return f ? all.filter((m) => m.toLowerCase().includes(f)) : all
  }, [available, filter, models, pre]) // eslint-disable-line react-hooks/exhaustive-deps

  const benchAll = async () => {
    for (const p of models) await useBench.getState().run(p.id)
  }
  const anyRunning = models.some((p) => running[p.id])

  return (
    <div className="connection">
      <div className="row">
        <b>{c.label}</b>
        {pre.needsKey ? (
          c.hasKey ? <span className="ok small">✓ key saved</span> : <span className="warn small">needs an API key</span>
        ) : (
          <span className="muted small">no key needed</span>
        )}
        {available && <span className="muted small">· {available.length} models available</span>}
        <span className="spacer" />
        {models.length > 1 && <button onClick={benchAll} disabled={anyRunning || !ready}>{anyRunning ? 'Benchmarking…' : `Benchmark all ${models.length}`}</button>}
        <button className="link danger" onClick={removeConnection}>Remove</button>
      </div>
      <div className="muted small">{pre.hint}{pre.keyUrl && <> Get a key: <a href={pre.keyUrl} target="_blank" rel="noreferrer">{pre.keyUrl.replace(/^https:\/\//, '')}</a></>}</div>

      <div className="row wrap conn-fields">
        {(pre.needsKey || c.preset === 'custom') && (
          <>
            <input
              type="password"
              value={key}
              placeholder={c.hasKey ? 'Key saved. Paste a new one to replace it' : 'Paste API key'}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            />
            <button className="primary" onClick={saveKey} disabled={!key.trim()}>Save key</button>
            {c.hasKey && <button className="link" onClick={async () => { await api().keys.set(c.id, null); await saveConfig({}) }}>Delete key</button>}
          </>
        )}
        {c.preset !== 'anthropic' && c.preset !== 'gemini' && c.preset !== 'openai' && (
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={saveUrl} onKeyDown={(e) => e.key === 'Enter' && saveUrl()} title="Endpoint" style={{ minWidth: 240 }} />
        )}
      </div>
      {loadErr && <div className="error">Couldn’t list models: {loadErr}</div>}

      <div className="model-list">
        {models.length === 0 && <div className="muted small">No models chosen yet.</div>}
        {models.map((p) => <ModelRow key={p.id} p={p} ready={ready} />)}
      </div>

      <div className="row">
        <button className="link" onClick={() => setPicking(!picking)}>{picking ? 'Done choosing models' : '+ Choose models'}</button>
      </div>
      {picking && (
        <div className="picker">
          {!ready && <div className="warn small">Save the key first to see every model this key can use. The recommended ones are listed below.</div>}
          {(pickList.length > 8 || filter) && <input placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <div className="picker-list">
            {pickList.map((m) => {
              const s = pre.suggested.find((x) => x.model === m)
              return (
                <label key={m} className="check">
                  <input type="checkbox" checked={has(m)} onChange={() => toggleModel(m)} />
                  <span>{s ? s.label : m}</span>
                  {s && <span className="muted small">{m}{s.note ? ` · ${s.note}` : ''}</span>}
                </label>
              )
            })}
            {pickList.length === 0 && <div className="muted small">{available ? 'No matching models.' : 'No model list yet.'}</div>}
          </div>
          <div className="row">
            <input placeholder="Or type a model id…" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) { toggleModel(custom.trim()); setCustom('') } }} />
            <button onClick={() => { if (custom.trim()) { toggleModel(custom.trim()); setCustom('') } }}>Add</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ModelRow({ p, ready }: { p: ProviderConfig; ready: boolean }) {
  const settings = useApp((s) => s.settings)
  const { saveConfig, setActiveProvider } = useApp.getState()
  const report = settings.benchmarks[p.id]
  const progress = useBench((s) => s.running[p.id])
  const [open, setOpen] = useState(false)
  const active = settings.activeProviderId === p.id
  const patch = (x: Partial<ProviderConfig>) => saveConfig({ providers: settings.providers.map((q) => (q.id === p.id ? { ...q, ...x } : q)) })

  return (
    <div className={`model-row ${active ? 'active' : ''}`}>
      <div className="row">
        <input type="radio" checked={active} onChange={() => setActiveProvider(p.id)} title="Use as tutor" />
        <b className="clickable" onClick={() => setOpen(!open)}>{p.label}</b>
        {p.label !== p.model && <span className="muted small">{p.model}</span>}
        {active && <span className="chip ok">tutor</span>}
        {report && <span className={`tier tier-${report.tier.toLowerCase()}`}>{report.tier} {pct(report.scores.overall)}</span>}
        {p.supportsTools === false && <span className="warn small">chat-only</span>}
        <span className="spacer" />
        <button onClick={() => { setOpen(true); useBench.getState().run(p.id) }} disabled={!!progress || !ready} title={ready ? '' : 'Save the API key first'}>
          {progress ? 'Benchmarking…' : report ? 'Re-run benchmark' : 'Run benchmark'}
        </button>
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
      </div>
      {open && (
        <div className="model-details">
          <div className="row wrap small">
            <label className="check">
              <input type="checkbox" checked={p.supportsTools !== false} onChange={(e) => patch({ supportsTools: e.target.checked ? undefined : false })} />
              Tool calling (drives the chart)
            </label>
            <label className="row">Temperature
              <input style={{ width: 70 }} defaultValue={p.temperature ?? ''} placeholder="default" onBlur={(e) => patch({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
          </div>
          {progress && <BenchProgress text={progress.text} checks={progress.checks} />}
          {!progress && report && <BenchReport r={report} />}
          {!progress && !report && <div className="muted small">Not benchmarked yet.</div>}
        </div>
      )}
    </div>
  )
}

function BenchProgress({ text, checks }: { text: string; checks: BenchCheck[] }) {
  return (
    <div className="bench">
      <div className="small"><span className="dots">{text}</span></div>
      {checks.map((c) => <CheckRow key={c.id} c={c} />)}
    </div>
  )
}

function BenchReport({ r }: { r: BenchmarkReport }) {
  const [open, setOpen] = useState(false)
  const old = (r.suiteVersion ?? 1) < 4
  return (
    <div className="bench">
      {old ? (
        <div className="small warn">This result is from an older, shorter benchmark. Re-run it to see all attributes.</div>
      ) : (
        <div className="scores">
          {ATTRIBUTES.map((a) => (
            <div key={a.id} className="score" title={a.usedFor}>
              <span>{a.name}</span>
              <div className="bar"><div style={{ width: pct(r.scores[a.id] ?? 0) }} /></div>
              <span className="num">{r.scores[a.id] === undefined ? '—' : pct(r.scores[a.id]!)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="small">
        First visible token {r.metrics.ttftMs ? `${Math.round(r.metrics.ttftMs)} ms` : 'n/a'} ·{' '}
        {r.metrics.tokensPerSec ? `${r.metrics.tokensPerSec.toFixed(1)} tokens/s` : 'tokens/s n/a'} ·{' '}
        avg response {Math.round(r.metrics.avgLatencyMs)} ms
        {r.metrics.totalTokens ? ` · ${r.metrics.totalTokens.toLocaleString()} tokens used` : ''} · {new Date(r.at).toLocaleString()}
      </div>
      <ul className="advice">{r.advice.map((a, i) => <li key={i}>{a}</li>)}</ul>
      <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} each check</button>
      {open && r.checks.map((c) => <CheckRow key={c.id} c={c} />)}
    </div>
  )
}

export function CheckRow({ c }: { c: BenchCheck }) {
  return (
    <div className="check-row">
      <span className={c.score >= 0.8 ? 'ok' : c.score >= 0.4 ? 'warn' : 'bad'}>{c.score >= 0.8 ? '✓' : c.score >= 0.4 ? '~' : '✗'}</span>
      <b>{c.name}</b>
      <span className="muted small">{c.detail}</span>
    </div>
  )
}
