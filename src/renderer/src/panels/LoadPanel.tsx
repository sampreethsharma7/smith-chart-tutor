import { useState } from 'react'
import { importFile, parseCstAscii, type CstColumnFormat } from '@shared/rf/importers'
import type { LoadModel } from '@shared/rf/network'
import { DEFAULT_SNAPSHOT, loadVariesWithFrequency, useStudio } from '@/state/studio'
import { api, useApp } from '@/state/app'
import { NumField } from '@/components/NumField'
import { fmtHz } from '@/lib/format'
import { confirmDialog } from '@/components/Confirm'

const KINDS: Array<{ id: string; label: string; make(): LoadModel }> = [
  { id: 'fixed', label: 'Fixed impedance', make: () => ({ kind: 'fixed', R: 25, X: 30 }) },
  { id: 'seriesRLC', label: 'Series RLC', make: () => ({ kind: 'seriesRLC', R: 20, L: 5e-9, C: 1e-12 }) },
  { id: 'parallelRLC', label: 'Parallel RLC', make: () => ({ kind: 'parallelRLC', R: 200, L: 2e-9, C: 2e-12 }) },
  { id: 'antenna:series', label: 'Antenna – dipole-like', make: () => ({ kind: 'antenna', topology: 'series', f0: 2.45e9, R: 30, Q: 8 }) },
  { id: 'antenna:parallel', label: 'Antenna – patch-like', make: () => ({ kind: 'antenna', topology: 'parallel', f0: 2.45e9, R: 200, Q: 25 }) }
]

/** Raw text of imported CST files so the column format can be changed afterwards. */
const rawFiles = new Map<string, { name: string; text: string }>()

export function LoadPanel() {
  const load = useStudio((s) => s.load)
  const z0 = useStudio((s) => s.z0)
  const datasets = useStudio((s) => s.datasets)
  const clickMode = useStudio((s) => s.clickMode)
  const st = useStudio.getState
  const [err, setErr] = useState<string | null>(null)

  const kindId = load.kind === 'antenna' ? `antenna:${load.topology}` : load.kind === 'data' ? `data:${load.datasetId}` : load.kind
  const upd = (patch: Partial<LoadModel>) => st().setLoad({ ...load, ...patch } as LoadModel)

  /** Moving an antenna's resonance outside the sweep would make the trace vanish: follow it. */
  const setF0 = (f0: number) => {
    upd({ f0 } as Partial<LoadModel>)
    const { sweep } = st()
    if (f0 < sweep.start || f0 > sweep.stop) {
      st().set('sweep', { ...sweep, start: f0 * 0.8, stop: f0 * 1.2 })
      st().set('designFreq', f0)
      st().set('markers', [f0])
    }
  }

  const resetChart = async () => {
    if (!(await confirmDialog('Reset the chart?\n\nIt goes back to the default antenna, sweep and markers. Your matching network and imported data on this chart are cleared.', { ok: 'Reset chart', danger: true }))) return
    const z0 = useApp.getState().profile?.preferences.defaultZ0 ?? 50
    st().loadSnapshot({ ...DEFAULT_SNAPSHOT, z0 })
    st().logEvent('reset', 'Reset the chart to the default setup')
  }

  const doImport = async () => {
    setErr(null)
    const files = await api().files.openData()
    const all = []
    for (const f of files) {
      try {
        const ds = importFile(f.name, f.text)
        ds.forEach((d) => rawFiles.set(d.id, f))
        all.push(...ds)
      } catch (e) {
        setErr(`${f.name}: ${(e as Error).message}`)
      }
    }
    if (all.length) {
      st().addDatasets(all)
      const d0 = all[0]
      st().setLoad({ kind: 'data', datasetId: d0.id })
      st().setShowBand(true, 'learner')
      st().set('sweep', { start: d0.freqs[0], stop: d0.freqs[d0.freqs.length - 1], points: 401 })
      const mid = d0.freqs[Math.floor(d0.freqs.length / 2)]
      st().set('designFreq', mid)
    }
  }

  const reparse = (id: string, fmt: CstColumnFormat) => {
    const raw = rawFiles.get(id)
    if (!raw) return
    try {
      const [d] = parseCstAscii(raw.text, raw.name, fmt)
      const updated = { ...d, id }
      st().set('datasets', st().datasets.map((x) => (x.id === id ? updated : x)))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const activeDs = load.kind === 'data' ? datasets.find((d) => d.id === load.datasetId) : undefined

  return (
    <section className="panel">
      <h3>Load</h3>
      <div className="row">
        <NumField label="Z0" value={z0} unit="Ω" min={0.001} onCommit={(v) => st().set('z0', v, `Changed Z0 to ${v} Ω`)} />
      </div>
      <select
        value={kindId}
        onChange={(e) => {
          const v = e.target.value
          const next: LoadModel = v.startsWith('data:') ? { kind: 'data', datasetId: v.slice(5) } : KINDS.find((k) => k.id === v)!.make()
          st().setLoad(next)
          // A new kind of load: show the band only if it changes with frequency.
          st().setShowBand(loadVariesWithFrequency(next), 'learner')
        }}
      >
        {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        {datasets.map((d) => <option key={d.id} value={`data:${d.id}`}>Data: {d.name}</option>)}
      </select>

      <div className="fields">
        {load.kind === 'fixed' && (
          <>
            <NumField label="R" value={load.R} unit="Ω" onCommit={(R) => upd({ R })} />
            <NumField label="X" value={load.X} unit="Ω" onCommit={(X) => upd({ X })} />
          </>
        )}
        {(load.kind === 'seriesRLC' || load.kind === 'parallelRLC') && (
          <>
            <NumField label="R" value={load.R} unit="Ω" min={0} onCommit={(R) => upd({ R })} />
            <NumField label="L" value={load.L} unit="H" eng min={0} onCommit={(L) => upd({ L })} />
            <NumField label="C" value={load.C} unit="F" eng min={0} onCommit={(C) => upd({ C })} />
          </>
        )}
        {load.kind === 'antenna' && (
          <>
            <NumField label="f0" value={load.f0} unit="Hz" eng min={1} onCommit={setF0} />
            <NumField label="R" value={load.R} unit="Ω" min={0.01} title="Resistance at resonance" onCommit={(R) => upd({ R })} />
            <NumField label="Q" value={load.Q} min={0.1} title="Unloaded Q (higher = narrower band)" onCommit={(Q) => upd({ Q })} />
          </>
        )}
      </div>

      {activeDs && (
        <div className="dsinfo">
          <div>{activeDs.source} · {activeDs.freqs.length} pts · {fmtHz(activeDs.freqs[0])} – {fmtHz(activeDs.freqs[activeDs.freqs.length - 1])} · ref {activeDs.z0} Ω</div>
          {activeDs.notes?.map((n, i) => <div key={i} className="muted">{n}</div>)}
          {activeDs.source.startsWith('CST') && rawFiles.has(activeDs.id) && (
            <label className="row">
              Columns:
              <select value={/\((\w+)\)/.exec(activeDs.source)?.[1]} onChange={(e) => reparse(activeDs.id, e.target.value as CstColumnFormat)}>
                <option value="reim">Re / Im of S11</option>
                <option value="magPhaseDeg">|S11| linear / phase °</option>
                <option value="dbPhaseDeg">|S11| dB / phase °</option>
                <option value="magPhaseRad">|S11| linear / phase rad</option>
                <option value="zReIm">Z11 Re / Im (Ω)</option>
              </select>
            </label>
          )}
          <button className="link" onClick={() => st().removeDataset(activeDs.id)}>Remove dataset</button>
        </div>
      )}

      <div className="row wrap">
        <button onClick={doImport} title="Touchstone .s1p/.s2p (CST: Post-Processing → Import/Export → Touchstone) or CST ASCII plot export">
          Import CST / Touchstone…
        </button>
        <button
          className={clickMode === 'setLoad' ? 'active' : ''}
          onClick={() => st().setClickMode(clickMode === 'setLoad' ? 'inspect' : 'setLoad')}
          title="Click anywhere on the chart to make that the load impedance"
        >
          {clickMode === 'setLoad' ? 'Click chart… (on)' : 'Pick load on chart'}
        </button>
        <button onClick={resetChart} title="Back to the default antenna, sweep and markers">Reset chart</button>
      </div>
      {err && <div className="error">{err}</div>}
    </section>
  )
}
