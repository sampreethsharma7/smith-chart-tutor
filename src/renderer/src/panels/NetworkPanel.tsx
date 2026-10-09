import { ELEMENT_LABEL, type ElementKind, type NetworkElement } from '@shared/rf/network'
import { useStudio, valuesCovered } from '@/state/studio'
import { CoveredNote } from '@/panels/Readout'
import { useDerived } from '@/state/derived'
import { NumField } from '@/components/NumField'
import { fmtC, fmtNum } from '@/lib/format'

const ADD: Array<{ kind: ElementKind; short: string }> = [
  { kind: 'seriesL', short: 'Ser L' }, { kind: 'seriesC', short: 'Ser C' },
  { kind: 'shuntL', short: 'Sh L' }, { kind: 'shuntC', short: 'Sh C' },
  { kind: 'tline', short: 'Line' }, { kind: 'openStub', short: 'Open stub' }, { kind: 'shortStub', short: 'Short stub' },
  { kind: 'seriesR', short: 'Ser R' }, { kind: 'shuntR', short: 'Sh R' }
]

const isLine = (k: ElementKind) => k === 'tline' || k.endsWith('Stub')
const isL = (k: ElementKind) => k === 'seriesL' || k === 'shuntL'
const isC = (k: ElementKind) => k === 'seriesC' || k === 'shuntC'

/** Slider in log |X| from 1 Ω to 2 kΩ at the design frequency, so L and C feel the same. */
const X_MIN = 0, X_SPAN = 3.3
function toSlider(el: NetworkElement, w: number): number {
  if (isLine(el.kind)) return el.value
  const x = isL(el.kind) ? w * el.value : isC(el.kind) ? 1 / (w * el.value) : el.value
  return Math.max(0, Math.min(1000, ((Math.log10(x) - X_MIN) / X_SPAN) * 1000))
}
function fromSlider(kind: ElementKind, s: number, w: number): number {
  if (isLine(kind)) return s
  const x = Math.pow(10, X_MIN + (X_SPAN * s) / 1000)
  return isL(kind) ? x / w : isC(kind) ? 1 / (w * x) : x
}

export function NetworkPanel() {
  const network = useStudio((s) => s.network)
  const designFreq = useStudio((s) => s.designFreq)
  const z0 = useStudio((s) => s.z0)
  const d = useDerived()
  const st = useStudio.getState
  const w = 2 * Math.PI * designFreq

  const add = (kind: ElementKind) => {
    const start = isLine(kind) ? 30 : fromSlider(kind, 500, w) // ~45 Ω reactance
    st().addElement(kind, start, isLine(kind) ? { zc: z0, refHz: designFreq } : {})
  }

  // Z after each element at the design frequency
  const nodes = d.path.map((seg) => seg[seg.length - 1])
  const covered = useStudio(valuesCovered)

  return (
    <section className="panel">
      <h3>Matching network <span className="muted">(load → source)</span></h3>
      <div className="addgrid">
        {ADD.map((a) => (
          <button key={a.kind} onClick={() => add(a.kind)} title={ELEMENT_LABEL[a.kind]}>{a.short}</button>
        ))}
      </div>
      {network.length === 0 && <div className="muted">No elements yet. Add one and drag its slider to see how it moves the point.</div>}
      <ol className="elements">
        {network.map((el, i) => {
          const g = nodes[i]
          const zAfter = g ? fmtC({ re: (1 - g.re * g.re - g.im * g.im) / ((1 - g.re) ** 2 + g.im ** 2), im: (2 * g.im) / ((1 - g.re) ** 2 + g.im ** 2) }) : '—'
          return (
            <li key={el.id}>
              <div className="el-head">
                <span className="el-idx">{i + 1}</span>
                <b>{ELEMENT_LABEL[el.kind]}</b>
                <span className="spacer" />
                <button className="icon" onClick={() => st().moveElement(el.id, -1)} title="Toward load">↑</button>
                <button className="icon" onClick={() => st().moveElement(el.id, 1)} title="Toward source">↓</button>
                <button className="icon" onClick={() => st().removeElement(el.id)} title="Remove">×</button>
              </div>
              <div className="row">
                <NumField
                  value={el.value}
                  unit={isL(el.kind) ? 'H' : isC(el.kind) ? 'F' : isLine(el.kind) ? '°' : 'Ω'}
                  eng={!isLine(el.kind)}
                  min={0}
                  width={84}
                  onCommit={(value) => st().updateElement(el.id, { value })}
                />
                {isLine(el.kind) && (
                  <NumField label="Zc" value={el.zc ?? 50} unit="Ω" min={0.1} width={52} onCommit={(zc) => st().updateElement(el.id, { zc })} />
                )}
              </div>
              <input
                type="range"
                min={0}
                max={isLine(el.kind) ? 180 : 1000}
                step={isLine(el.kind) ? 0.5 : 1}
                value={toSlider(el, w)}
                onChange={(e) => st().updateElement(el.id, { value: fromSlider(el.kind, Number(e.target.value), w) })}
              />
              <div className="muted small">
                {isLine(el.kind) ? `${fmtNum(el.value / 360, 3)} λ at ${fmtNum((el.refHz ?? designFreq) / 1e9, 4)} GHz · ` : ''}
                z after: {covered ? <CoveredNote inline /> : zAfter}
              </div>
            </li>
          )
        })}
      </ol>
      {network.length > 0 && <button className="link" onClick={() => st().clearNetwork()}>Clear network</button>}
    </section>
  )
}
