import { metricsFromGamma, type PointMetrics } from '@shared/rf/metrics'
import type { Band } from '@shared/rf/network'
import { useHover, useStudio, valuesCovered } from '@/state/studio'
import { resultRows, useDerived } from '@/state/derived'
import { fmtC, fmtDb, fmtEng, fmtHz, fmtNum } from '@/lib/format'

/** Full metric card for whatever the user is looking at: hover → pinned → design input. */
export function InspectCard() {
  const hover = useHover((s) => s.gamma)
  const snap = useHover((s) => s.snap)
  const pinned = useStudio((s) => s.pinned)
  const z0 = useStudio((s) => s.z0)
  const network = useStudio((s) => s.network)
  const d = useDerived()
  const covered = useStudio(valuesCovered)
  let title: string
  let m: PointMetrics
  if (hover && snap) {
    title = `${snap.which === 'load' ? 'Load' : 'Input'} at ${fmtHz(snap.f, 4)}`
    m = metricsFromGamma(snap.g, z0, snap.f)
  } else if (hover) {
    title = 'Cursor'
    m = metricsFromGamma(hover, z0, d.design.f)
  } else if (pinned) {
    title = 'Pinned point'
    m = metricsFromGamma(pinned, z0, d.design.f)
  } else {
    title = network.length ? `Input @ ${fmtHz(d.design.f)}` : `Load @ ${fmtHz(d.design.f)}`
    m = network.length ? d.design.input : d.design.load
  }
  return (
    <div className="inspect">
      <h4>{covered ? 'Values' : title}</h4>
      {covered ? <CoveredNote /> : <MetricGrid m={m} />}
    </div>
  )
}

/** In place of numbers that would answer the open reading question (reading.ts). */
export function CoveredNote({ inline }: { inline?: boolean }) {
  const text = 'Covered while you answer: read it from the chart.'
  return inline
    ? <span className="covered-note" title="They come back when you answer. Show values on the question card uncovers them, but the answer then counts partly.">covered</span>
    : <div className="covered-note" title="They come back when you answer. Show values on the question card uncovers them, but the answer then counts partly.">{text}</div>
}

export function MetricGrid({ m }: { m: PointMetrics }) {
  const eq = (e?: PointMetrics['seriesEquivalent']) =>
    !e || e.kind === 'none' ? '—' : fmtEng(e.value, e.kind === 'L' ? 'H' : 'F')
  const rows: Array<[string, string, string?]> = [
    ['Z', fmtC(m.Z, 'Ω'), 'Impedance'],
    ['z', fmtC(m.z), 'Normalized impedance Z/Z0'],
    ['Y', fmtC({ re: m.Y.re * 1e3, im: m.Y.im * 1e3 }, 'mS'), 'Admittance'],
    ['y', fmtC(m.y), 'Normalized admittance'],
    ['Γ', `${fmtNum(m.gammaMag)} ∠ ${m.gammaDeg.toFixed(1)}°`, 'Reflection coefficient'],
    ['VSWR', fmtNum(m.vswr), 'Voltage standing-wave ratio'],
    ['RL', fmtDb(m.returnLossDb), 'Return loss (−|S11| dB)'],
    ['ML', fmtDb(m.mismatchLossDb, 3), 'Mismatch loss'],
    ['P del.', `${(m.powerDelivered * 100).toFixed(1)} %`, 'Power delivered to the load'],
    ['Q', fmtNum(m.q), 'Node Q = |X|/R'],
    ['WTG', `${m.wtg.toFixed(4)} λ`, 'Wavelengths toward generator'],
    ['WTL', `${m.wtl.toFixed(4)} λ`, 'Wavelengths toward load'],
    ['Ser. eq.', eq(m.seriesEquivalent), 'Series reactance as an L or C at the design frequency'],
    ['Sh. eq.', eq(m.shuntEquivalent), 'Shunt susceptance as an L or C at the design frequency']
  ]
  return (
    <dl className="metrics">
      {rows.map(([k, v, t]) => (
        <div key={k} title={`${t}: ${v}`}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Results under the chart. The table is always there: the design frequency is the first
 * row in both modes. Marker rows and bandwidth lines belong to the frequency band, so
 * single-frequency mode leaves them out and says where they went.
 */
export function MarkerTable() {
  const d = useDerived()
  const network = useStudio((s) => s.network)
  const thr = useStudio((s) => s.overlays.vswrCircle) ?? 2
  const has = network.length > 0
  const band = useStudio((s) => s.showBand)
  const rows = resultRows(d, band)
  const covered = useStudio(valuesCovered)
  if (covered) return <div className="marker-table"><CoveredNote /></div>
  return (
    <div className="marker-table">
      <table>
        <thead>
          <tr>
            <th>Point</th><th>f</th><th>Z load</th>{has && <th>Z in</th>}
            <th>VSWR</th><th>RL</th><th>Q</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = has ? r.input : r.load
            return (
              <tr key={r.name} className={r.name === 'Design' ? 'design' : ''} title={r.title}>
                <td>{r.name}</td>
                <td>{fmtHz(r.f)}</td>
                <td>{fmtC(r.load.Z, 'Ω')}</td>
                {has && <td>{fmtC(r.input.Z, 'Ω')}</td>}
                <td className={p.vswr <= thr ? 'ok' : ''}>{fmtNum(p.vswr)}</td>
                <td>{fmtDb(p.returnLossDb, 1)}</td>
                <td>{fmtNum(p.q)}</td>
              </tr>
            )
          })}
          {band && d.markers.length === 0 && <tr><td colSpan={7} className="muted">No markers: add target frequencies in the Frequency panel.</td></tr>}
        </tbody>
      </table>
      {band ? (
        <div className="bands">
          <BandList title={`Load: VSWR ≤ ${thr}`} bands={d.loadBands} />
          {has && <BandList title={`Matched: VSWR ≤ ${thr}`} bands={d.inputBands} />}
        </div>
      ) : (
        <div className="bands muted">
          {/* One line of text: .bands stacks its children, so keep the sentence in a single element */}
          <span>Single frequency: all values are at {fmtHz(d.design.f)}. Marker rows and bandwidth appear when you turn on <b>frequency band</b> (chart legend or Frequency panel).</span>
        </div>
      )}
    </div>
  )
}

function BandList({ title, bands }: { title: string; bands: Band[] }) {
  return (
    <div>
      <b>{title}</b>{' '}
      {bands.length === 0 ? <span className="muted">no band in sweep</span> : bands.map((b, i) => (
        <span key={i} className="band">
          {fmtHz(b.fLow, 4)} – {fmtHz(b.fHigh, 4)} ({fmtHz(b.bandwidth, 3)}, {(b.fractional * 100).toFixed(1)} %{b.clipped ? ', at sweep edge' : ''})
        </span>
      ))}
    </div>
  )
}
