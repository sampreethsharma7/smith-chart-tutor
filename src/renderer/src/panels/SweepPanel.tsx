import { useState } from 'react'
import { useStudio } from '@/state/studio'
import { NumField } from '@/components/NumField'
import { fmtHz, parseEng } from '@/lib/format'

export function SweepPanel() {
  const sweep = useStudio((s) => s.sweep)
  const designFreq = useStudio((s) => s.designFreq)
  const markers = useStudio((s) => s.markers)
  const overlays = useStudio((s) => s.overlays)
  const band = useStudio((s) => s.showBand)
  const st = useStudio.getState
  const [mk, setMk] = useState('')
  /** A trace or the path switched by the learner: the tutor hears about it, so it doesn't point at what they've hidden. */
  const toggle = (key: 'showPath' | 'showLoadTrace' | 'showInputTrace', name: string, on: boolean) => {
    st().setOverlays({ [key]: on })
    st().logEvent(`overlay_${key}`, `Learner ${on ? 'showed' : 'hid'} the ${name}`)
  }

  const addMarker = () => {
    const f = parseEng(mk)
    if (Number.isFinite(f) && f > 0) {
      st().addMarker(f)
      setMk('')
    }
  }

  return (
    <section className="panel">
      <h3>Frequency</h3>
      <div className="fields">
        <NumField
          label="Design"
          value={designFreq}
          unit="Hz"
          eng
          min={1}
          title="Frequency used for the matching path, L/IN points and element arcs"
          onCommit={(f) => st().set('designFreq', f, `Design frequency set to ${fmtHz(f)}`)}
        />
        <label className="check" title="Show how the load (and your match) change across a band of frequencies: sweep traces, markers and bandwidth. Off: the design frequency only.">
          <input type="checkbox" checked={band} onChange={(e) => st().setShowBand(e.target.checked, 'learner')} /> Frequency band
        </label>
      </div>
      {band && (<>
      <div className="fields">
        <NumField label="Start" value={sweep.start} unit="Hz" eng min={1} onCommit={(start) => st().set('sweep', { ...sweep, start })} />
        <NumField label="Stop" value={sweep.stop} unit="Hz" eng min={1} onCommit={(stop) => st().set('sweep', { ...sweep, stop })} />
        <NumField label="Pts" value={sweep.points} min={2} onCommit={(points) => st().set('sweep', { ...sweep, points: Math.min(5001, Math.round(points)) })} />
      </div>
      <div className="row">
        <input placeholder="Target f, e.g. 2.45G" value={mk} onChange={(e) => setMk(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addMarker()} />
        <button onClick={addMarker}>+ Marker</button>
      </div>
      <div className="chips">
        {markers.map((f, i) => (
          <span key={f} className="chip" onDoubleClick={() => st().set('designFreq', f)} title="Double-click: make this the design frequency">
            M{i + 1} {fmtHz(f)} <button onClick={() => st().removeMarker(f)}>×</button>
          </span>
        ))}
      </div>
      </>)}

      <h3>Overlays</h3>
      <div className="fields">
        <label className="check"><input type="checkbox" checked={overlays.admittance} onChange={(e) => st().setOverlays({ admittance: e.target.checked })} /> Admittance grid</label>
        <label className="check"><input type="checkbox" checked={overlays.showPath} onChange={(e) => toggle('showPath', 'matching path', e.target.checked)} /> Matching path</label>
        {band && <label className="check"><input type="checkbox" checked={overlays.showLoadTrace} onChange={(e) => toggle('showLoadTrace', 'load trace', e.target.checked)} /> Load trace</label>}
        {band && <label className="check"><input type="checkbox" checked={overlays.showInputTrace} onChange={(e) => toggle('showInputTrace', 'input trace', e.target.checked)} /> Input trace</label>}
        <label className="check">
          <input type="checkbox" checked={overlays.vswrCircle !== null} onChange={(e) => st().setOverlays({ vswrCircle: e.target.checked ? 2 : null })} /> VSWR circle
          {overlays.vswrCircle !== null && <NumField value={overlays.vswrCircle} min={1.01} width={48} onCommit={(v) => st().setOverlays({ vswrCircle: v })} />}
        </label>
        <label className="check">
          <input type="checkbox" checked={overlays.qContour !== null} onChange={(e) => st().setOverlays({ qContour: e.target.checked ? 1 : null })} /> Q ≤
          {overlays.qContour !== null && <NumField value={overlays.qContour} min={0.05} width={48} onCommit={(v) => st().setOverlays({ qContour: v })} />}
        </label>
      </div>
    </section>
  )
}
