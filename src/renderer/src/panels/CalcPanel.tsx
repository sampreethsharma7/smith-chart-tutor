import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CONVERT_FROM, type ConvertFrom, type NetworkStep, type Step } from '@shared/rf/calc'
import { zFromGamma } from '@shared/rf/metrics'
import { useStudio, valuesCovered } from '@/state/studio'
import { useDerived } from '@/state/derived'
import { addComponent, convertLocked, networkLocked, pointText, runCalc, useCalc, type CalcInputs, type CalcTab } from '@/state/calc'
import { Tex } from '@/components/Tex'
import { cplx } from '@shared/rf/calc'
import { fmtHz } from '@/lib/format'
import { PATH_COLORS } from '@/chart/StudioChart'

const TABS: Array<{ id: CalcTab; label: string; title: string }> = [
  { id: 'convert', label: 'Convert', title: 'Z, z, y, Γ, VSWR, return loss and Q of one point' },
  { id: 'component', label: 'Component', title: 'The L or C that adds a reactance or susceptance, or moves the point from one spot to another' },
  { id: 'network', label: 'Network', title: 'What each element of your network does to z, step by step' }
]

/**
 * Smith chart calculator: the arithmetic that goes with reading the chart. It
 * shows its working as formulas, so it teaches the calculation rather than hiding it.
 */
export function CalcPanel() {
  const c = useCalc(useShallow((s) => ({ ...s })))
  // Recompute when the chart changes (network, frequency, Z0, load).
  const chart = useStudio(useShallow((s) => [s.network, s.designFreq, s.z0, s.load, s.datasets]))
  const prediction = useStudio((s) => s.prediction)
  const designFreq = useStudio((s) => s.designFreq)
  const z0 = useStudio((s) => s.z0)
  const locked = (c.tab === 'convert' && convertLocked()) || (c.tab === 'network' && networkLocked())
  const out = useMemo(() => (locked ? {} : runCalc(c)), [c, locked, prediction, chart]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<CalcInputs>) => c.set(patch, 'learner')

  // Note a result for the tutor once the learner stops typing.
  const key = out.summary ?? ''
  useEffect(() => {
    // The network tab follows the chart by itself; opening a step is what gets noted (below).
    if (!key || c.tutorNote || c.tab === 'network') return
    const t = setTimeout(() => useCalc.getState().logUse(), 1200)
    return () => clearTimeout(t)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the tutor fills it in, bring it into view (it sits below the network, often off-screen).
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (c.tutorNote && c.open) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [c.tutorNote, c.open])

  return (
    <section ref={ref} className={`panel calc${c.tutorNote ? ' by-tutor' : ''}`}>
      <h3>
        <button className="collapsible" aria-expanded={c.open} onClick={() => c.setOpen(!c.open)} title={c.open ? 'Hide the calculator' : 'Show the calculator'}>
          {c.open ? '▾' : '▸'} Calculator <span className="muted">(at {fmtHz(designFreq)}, Z0 {z0} Ω)</span>
        </button>
      </h3>
      {c.open && (
        <>
          {c.tutorNote && <div className="calc-note">🎓 From your tutor: {c.tutorNote}</div>}
          <div className="seg">
            {TABS.map((t) => (
              <button key={t.id} className={c.tab === t.id ? 'active' : ''} title={t.title} onClick={() => set({ tab: t.id })}>{t.label}</button>
            ))}
          </div>
          {c.tab === 'convert' && (locked ? <div className="muted small">The converter is paused while a "read this value" question is open: that question is about working it out yourself. The other tabs still work.</div> : <ConvertInputs c={c} set={set} />)}
          {c.tab === 'component' && <ComponentInputs c={c} set={set} />}
          {c.tab === 'network' && locked && <div className="muted small">Paused while a reading question is open: it lists the values that would answer it. It comes back when you answer.</div>}
          {out.error && <div className="muted small">{out.error}</div>}
          {out.result && (
            <>
              {out.result.warning && <div className="warn small">⚠ {out.result.warning}</div>}
              <dl className="calc-out">
                {out.result.outputs.map((o) => (
                  <div key={o.label}><dt>{o.label}</dt><dd>{o.text}</dd></div>
                ))}
              </dl>
              {out.result.component && !out.result.warning && (
                <button onClick={() => addComponent(out.result!.component!)} title="Put this part on the chart, at the end of the network (source side)">+ Add {out.result.component.text} to the network</button>
              )}
              <Working steps={out.result.steps} />
            </>
          )}
          {out.rows && <NetworkRows rows={out.rows} />}
        </>
      )}
    </section>
  )
}

function Working({ steps }: { steps: Step[] }) {
  const show = useCalc((s) => s.showWorking)
  if (!steps.length) return null
  return (
    <div className="working">
      <button className="link small" onClick={() => useCalc.getState().setShowWorking(!show)}>{show ? '▾ Hide working' : '▸ Show working'}</button>
      {show && (
        <ol>
          {steps.map((s, i) => (
            <li key={i}><span className="muted small">{s.label}</span><Tex tex={s.tex} block /></li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Buttons that fill a field from the chart: the load, the input, or the point you clicked. */
function Pickers({ onPick, as }: { onPick(text: string): void; as: 'z' | 'y' | 'Z' }) {
  const d = useDerived()
  const has = useStudio((s) => s.network.length > 0)
  const pinned = useStudio((s) => s.pinned)
  const z0 = useStudio((s) => s.z0)
  const covered = useStudio(valuesCovered)
  const norm = (Z: { re: number; im: number }) => ({ re: Z.re / z0, im: Z.im / z0 })
  // They'd fill in the exact z or y of the point a reading question asks about.
  if (covered) return <div className="pickers small muted">Picking points from the chart is paused while a reading question is open.</div>
  return (
    <div className="pickers small">
      <span className="muted">from the chart:</span>
      <button className="link" onClick={() => onPick(pointText(norm(d.design.ZL), as))} title="The load at the design frequency">load</button>
      {has && <button className="link" onClick={() => onPick(pointText(norm(d.design.Zin), as))} title="The input (after your network) at the design frequency">input</button>}
      <button className="link" disabled={!pinned} onClick={() => pinned && onPick(pointText(zFromGamma(pinned, 1), as))} title={pinned ? 'The point you clicked on the chart' : 'Click a point on the chart first'}>clicked point</button>
    </div>
  )
}

function ConvertInputs({ c, set }: { c: CalcInputs; set(p: Partial<CalcInputs>): void }) {
  const as: 'z' | 'y' | 'Z' = c.convertFrom === 'y' ? 'y' : c.convertFrom === 'Z' ? 'Z' : 'z'
  return (
    <>
      <div className="row">
        <select value={c.convertFrom} style={{ width: 'auto' }} onChange={(e) => set({ convertFrom: e.target.value as ConvertFrom, convertText: '' })}>
          {(Object.keys(CONVERT_FROM) as ConvertFrom[]).map((k) => <option key={k} value={k}>{CONVERT_FROM[k].label}</option>)}
        </select>
        <input value={c.convertText} placeholder={CONVERT_FROM[c.convertFrom].hint} onChange={(e) => set({ convertText: e.target.value })} />
      </div>
      {c.convertFrom !== 'gamma' && c.convertFrom !== 'Y' && <Pickers as={as} onPick={(t) => set({ convertText: t })} />}
    </>
  )
}

function ComponentInputs({ c, set }: { c: CalcInputs; set(p: Partial<CalcInputs>): void }) {
  const amountLabel = c.conn === 'series' ? (c.normalised ? 'x' : 'X (Ω)') : c.normalised ? 'b' : 'B (S)'
  return (
    <>
      <div className="seg small">
        <button className={c.compMode === 'value' ? 'active' : ''} onClick={() => set({ compMode: 'value' })} title="I know the reactance or susceptance to add">Add an amount</button>
        <button className={c.compMode === 'move' ? 'active' : ''} onClick={() => set({ compMode: 'move' })} title="I know where the point is and where it should go">From → to</button>
      </div>
      <div className="seg small">
        <button className={c.conn === 'series' ? 'active' : ''} onClick={() => set({ conn: 'series' })} title="Adds reactance: moves along a constant-r circle">Series</button>
        <button className={c.conn === 'shunt' ? 'active' : ''} onClick={() => set({ conn: 'shunt' })} title="Adds susceptance: moves along a constant-g circle">Shunt</button>
      </div>
      {c.compMode === 'value' ? (
        <div className="row">
          <span className="calc-lbl">{amountLabel}</span>
          <input value={c.amountText} placeholder={c.normalised ? 'e.g. +0.8 or −1.2' : c.conn === 'series' ? 'e.g. 40 or −25' : 'e.g. 10m or −8m'} onChange={(e) => set({ amountText: e.target.value })} />
          <label className="small nowrap" title="Normalised (read off the chart) or in Ω / S">
            <input type="checkbox" checked={c.normalised} onChange={(e) => set({ normalised: e.target.checked })} /> normalised
          </label>
        </div>
      ) : (
        <>
          <div className="row">
            <span className="calc-lbl">from</span>
            <input value={c.fromText} placeholder={c.pointsAs === 'z' ? 'e.g. 0.6 + j0.4' : 'e.g. 1.15 − j0.77'} onChange={(e) => set({ fromText: e.target.value })} />
            <select value={c.pointsAs} style={{ width: 'auto' }} title="Type the points as impedance (z) or admittance (y)" onChange={(e) => set({ pointsAs: e.target.value as 'z' | 'y', fromText: '', toText: '' })}>
              <option value="z">z</option>
              <option value="y">y</option>
            </select>
          </div>
          <Pickers as={c.pointsAs} onPick={(t) => set({ fromText: t })} />
          <div className="row">
            <span className="calc-lbl">to</span>
            <input value={c.toText} placeholder={c.pointsAs === 'z' ? 'e.g. 1 + j1.1' : 'e.g. 1 − j0.5'} onChange={(e) => set({ toText: e.target.value })} />
          </div>
          <Pickers as={c.pointsAs} onPick={(t) => set({ toText: t })} />
        </>
      )}
    </>
  )
}

function noteStep(r: NetworkStep) {
  useStudio.getState().logEvent('calc', `Looked at the calculator's working for network step ${r.index + 1} (${r.title}): z ${cplx(r.zBefore)} → ${cplx(r.zAfter)}`)
}

function NetworkRows({ rows }: { rows: NetworkStep[] }) {
  const highlight = useCalc((s) => s.highlight)
  const [open, setOpen] = useState<number | null>(null)
  if (!rows.length) return null
  return (
    <ol className="calc-steps">
      <li className="muted small">z<sub>L</sub> = {cplx(rows[0].zBefore)} (load)</li>
      {rows.map((r) => (
        <li
          key={r.index}
          className={highlight === r.index ? 'hl' : ''}
          onMouseEnter={() => useCalc.getState().setHighlight(r.index)}
          onMouseLeave={() => useCalc.getState().setHighlight(null)}
        >
          <button
            className="calc-step-head"
            onFocus={() => useCalc.getState().setHighlight(r.index)}
            onBlur={() => useCalc.getState().setHighlight(null)}
            onClick={() => { setOpen(open === r.index ? null : r.index); if (open !== r.index) noteStep(r) }} title="Show the working for this step; its path is highlighted on the chart">
            <i style={{ background: PATH_COLORS[r.index % PATH_COLORS.length] }} />
            <b>{r.index + 1}. {r.title}</b>
            <span className="spacer" />
            <span>z = {cplx(r.zAfter)}</span>
            <span className="muted">{open === r.index ? '▾' : '▸'}</span>
          </button>
          {open === r.index && (
            <ol className="working-steps">
              {r.steps.map((s, i) => <li key={i}><span className="muted small">{s.label}</span><Tex tex={s.tex} block /></li>)}
            </ol>
          )}
        </li>
      ))}
    </ol>
  )
}
