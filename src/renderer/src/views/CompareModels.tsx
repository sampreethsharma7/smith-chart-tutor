import { useEffect, useMemo, useState } from 'react'
import { ATTRIBUTES, fitScore, SUITE_VERSION, type Attribute, type BenchCheck, type BenchmarkReport } from '@shared/benchmark'
import REFERENCE from '@shared/benchmark-reference.json'
import { useApp } from '@/state/app'
import { useBench } from '@/state/bench'

interface Row {
  id: string
  label: string
  model: string
  source: 'reference' | 'yours' | 'running'
  report: Pick<BenchmarkReport, 'scores' | 'checks' | 'metrics' | 'at' | 'machine' | 'kind'>
}

/** Use-case presets: which attributes matter for which way of using the tool. */
const PRESETS: Array<{ label: string; attrs: Attribute[]; hint: string }> = [
  { label: 'Everything', attrs: ATTRIBUTES.map((a) => a.id), hint: 'Overall fit as a tutor' },
  { label: 'Socratic coaching', attrs: ['guiding', 'tools', 'rf_knowledge', 'learner'], hint: 'Make me think, drive exercises, track progress' },
  { label: 'Explanations', attrs: ['rf_knowledge', 'guiding', 'summary'], hint: 'Mostly chatting about concepts' },
  { label: 'Quick drills', attrs: ['speed', 'tools', 'guiding'], hint: 'Fast back-and-forth practice' },
  { label: 'Accuracy', attrs: ['rf_knowledge', 'rf_math', 'tools'], hint: 'Getting the RF right' }
]

const STORE_KEY = 'compare.v1'
function loadPrefs(): { attrs: Attribute[]; hidden: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '')
    if (Array.isArray(v.attrs) && Array.isArray(v.hidden)) return v
  } catch {
    /* first run or storage unavailable */
  }
  return { attrs: ATTRIBUTES.map((a) => a.id), hidden: [] }
}

/** Partial scores while a benchmark is still running. */
function scoresFromChecks(checks: BenchCheck[]): BenchmarkReport['scores'] {
  const scores: BenchmarkReport['scores'] = { overall: 0 }
  for (const a of ATTRIBUTES) {
    const xs = checks.filter((c) => c.category === a.id)
    if (xs.length) scores[a.id] = xs.reduce((s, c) => s + c.score, 0) / xs.length
  }
  return scores
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const fmtLatency = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

export function CompareModels() {
  const settings = useApp((s) => s.settings)
  const running = useBench((s) => s.running)
  const [prefs, setPrefs] = useState(loadPrefs)
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  const { rows, olderHidden, failedHidden } = useMemo(() => {
    // A reference entry made from one of your own runs is the same run: show it once, as yours.
    const yourRunIds = new Set([...(settings.benchmarkHistory ?? []), ...Object.values(settings.benchmarks)].map((r) => r.id))
    const out: Row[] = (REFERENCE as BenchmarkReport[]).filter((r) => !yourRunIds.has(r.id)).map((r) => ({
      id: `ref:${r.kind}:${r.model}`, label: r.providerLabel, model: r.model, source: 'reference', report: r
    }))
    // Your runs: latest per provider+model, including models you have since deleted.
    const latest = new Map<string, BenchmarkReport>()
    const older = new Set<string>()
    const failed = new Set<string>()
    for (const r of [...(settings.benchmarkHistory ?? []), ...Object.values(settings.benchmarks)]) {
      if ((r.suiteVersion ?? 1) < SUITE_VERSION) { older.add(`${r.providerId}:${r.model}`); continue }
      if (r.tier === 'Failed') { failed.add(`${r.providerId}:${r.model}`); continue }
      const k = `${r.providerId}:${r.model}`
      if (!latest.has(k) || latest.get(k)!.at < r.at) latest.set(k, r)
    }
    for (const [k, r] of latest) {
      const name = settings.providers.find((p) => p.id === r.providerId)?.label ?? r.providerLabel
      out.push({ id: `run:${k}`, label: name, model: r.model, source: 'yours', report: r })
    }
    for (const [pid, pr] of Object.entries(running)) {
      const p = settings.providers.find((x) => x.id === pid)
      if (!p) continue
      out.push({
        id: `live:${pid}`, label: p.label, model: p.model, source: 'running',
        report: { scores: scoresFromChecks(pr.checks), checks: pr.checks, metrics: { ttftMs: null, tokensPerSec: null, avgLatencyMs: 0 }, at: new Date().toISOString(), kind: p.kind }
      })
    }
    for (const k of latest.keys()) { older.delete(k); failed.delete(k) } // re-run successfully since
    return { rows: out, olderHidden: older.size, failedHidden: failed.size }
  }, [settings, running])

  const attrs = ATTRIBUTES.filter((a) => prefs.attrs.includes(a.id))
  const visible = rows.filter((r) => !prefs.hidden.includes(r.id))
  const ranked = visible
    .map((r) => ({ r, fit: fitScore(r.report.scores, prefs.attrs) }))
    .sort((a, b) => b.fit - a.fit)
  const hidden = rows.filter((r) => prefs.hidden.includes(r.id))
  const best: Partial<Record<Attribute | 'fit', number>> = {}
  for (const { r, fit } of ranked) {
    for (const a of attrs) best[a.id] = Math.max(best[a.id] ?? -1, r.report.scores[a.id] ?? -1)
    best.fit = Math.max(best.fit ?? -1, fit)
  }

  // The model you're testing now (or tested most recently) and where it lands.
  const focus = rows.find((r) => r.source === 'running') ??
    rows.filter((r) => r.source === 'yours').sort((a, b) => (a.report.at < b.report.at ? 1 : -1))[0]
  const focusRank = focus ? ranked.findIndex((x) => x.r.id === focus.id) + 1 : 0

  const toggleAttr = (id: Attribute) =>
    setPrefs((p) => {
      const has = p.attrs.includes(id)
      if (has && p.attrs.length === 1) return p // keep at least one
      return { ...p, attrs: has ? p.attrs.filter((x) => x !== id) : [...p.attrs, id] }
    })
  const toggleRow = (id: string) =>
    setPrefs((p) => ({ ...p, hidden: p.hidden.includes(id) ? p.hidden.filter((x) => x !== id) : [...p.hidden, id] }))

  if (rows.length === 0) {
    return (
      <>
        <h3>Compare models</h3>
        <p className="muted small">Run a benchmark to see how models compare on each job in the tool.</p>
      </>
    )
  }

  return (
    <section className="compare-wrap">
      <h3>Compare models</h3>
      <p className="muted small">
        Reference results were measured by us; “yours” are runs on this machine (kept even if you delete the model). Pick what matters to you;
        the ranking re-weights to those attributes only. Speed of local models depends on the PC they ran on.
      </p>

      <div className="row wrap">
        <span className="small">Use case:</span>
        {PRESETS.map((p) => {
          const on = p.attrs.length === prefs.attrs.length && p.attrs.every((a) => prefs.attrs.includes(a))
          return <button key={p.label} className={on ? 'active' : ''} title={p.hint} onClick={() => setPrefs((x) => ({ ...x, attrs: p.attrs }))}>{p.label}</button>
        })}
      </div>
      <div className="attr-toggles">
        {ATTRIBUTES.map((a) => (
          <label key={a.id} className={`attr ${prefs.attrs.includes(a.id) ? 'on' : ''}`} title={a.usedFor}>
            <input type="checkbox" checked={prefs.attrs.includes(a.id)} onChange={() => toggleAttr(a.id)} />
            {a.name}
          </label>
        ))}
      </div>

      {focus && focusRank > 0 && (
        <div className="note">
          <b>{focus.label}</b>{focus.source === 'running' ? ' (still running)' : ''} ranks <b>#{focusRank} of {ranked.length}</b> on {attrs.length === ATTRIBUTES.length ? 'all attributes' : attrs.map((a) => a.name).join(', ')}.
        </div>
      )}

      <div className="table-scroll">
        <table className="compare heat">
          <thead>
            <tr>
              <th />
              <th>#</th>
              <th>Model</th>
              {attrs.map((a) => <th key={a.id} title={a.usedFor}>{a.name}</th>)}
              <th title="Weighted over the selected attributes">Fit</th>
              <th title="Time to first visible token">1st token</th>
              <th>Tokens/s</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ r, fit }, i) => (
              <tr key={r.id} className={r.id === focus?.id ? 'focus' : ''}>
                <td><input type="checkbox" checked onChange={() => toggleRow(r.id)} title="Hide from comparison" /></td>
                <td className="num">{i + 1}</td>
                <td>
                  <div>{r.label}</div>
                  <div className="muted small">
                    <span className={`src src-${r.source}`}>{r.source === 'reference' ? 'reference' : r.source === 'running' ? 'running…' : 'yours'}</span>{' '}
                    {r.model}{r.report.machine ? ` · ${r.report.machine}` : ''}
                  </div>
                </td>
                {attrs.map((a) => {
                  const v = r.report.scores[a.id]
                  const tip = r.report.checks.filter((c) => c.category === a.id).map((c) => `${c.name}: ${Math.round(c.score * 100)}% — ${c.detail}`).join('\n')
                  return (
                    <td key={a.id} className="cell" title={tip || 'Not measured'} style={v === undefined ? undefined : { background: `color-mix(in srgb, var(--accent) ${Math.round(v * 55)}%, transparent)` }}>
                      {v === undefined ? '—' : pct(v)}{v !== undefined && v === best[a.id] && ranked.length > 1 ? ' ★' : ''}
                    </td>
                  )
                })}
                <td className="cell fit"><b>{pct(fit)}</b>{fit === best.fit && ranked.length > 1 ? ' ★' : ''}</td>
                <td className="num">{fmtLatency(r.report.metrics.ttftMs)}</td>
                <td className="num">{r.report.metrics.tokensPerSec ? r.report.metrics.tokensPerSec.toFixed(0) : '—'}</td>
              </tr>
            ))}
            {hidden.map((r) => (
              <tr key={r.id} className="hidden-row">
                <td><input type="checkbox" checked={false} onChange={() => toggleRow(r.id)} title="Show in comparison" /></td>
                <td />
                <td colSpan={attrs.length + 4}>
                  {r.label} <span className="muted small">{r.source} · {r.model} · hidden</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failedHidden > 0 && <p className="muted small">{failedHidden} run(s) failed (unreachable model, quota or outage) and are not shown. Open the model under Connections for the error.</p>}
      {olderHidden > 0 && <p className="muted small">{olderHidden} result(s) from the older, shorter benchmark are not shown. Re-run those models to compare them.</p>}
      <p className="muted small">★ best among the shown models. Hover a score for what was tested. Fit weights: {ATTRIBUTES.filter((a) => prefs.attrs.includes(a.id)).map((a) => `${a.name} ${Math.round(a.weight * 100)}`).join(', ')} (renormalised).</p>
    </section>
  )
}
