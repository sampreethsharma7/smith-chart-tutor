import { useState } from 'react'
import { capstoneProblem, makeCapstone, milestones, stageOf, titleOf, upNext, type Capstone, type CapstoneLoad, type CapstoneParts } from '@shared/capstone'
import type { Profile } from '@shared/profile'
import { useApp } from '@/state/app'
import { useStudio } from '@/state/studio'

/**
 * Their project (capstone.ts) on the Progress page: what it is, why, the route with each milestone
 * ticked as their own answers reach it, and a form to set or change it (theirs to decide).
 */
export function ProjectCard({ profile }: { profile: Profile }) {
  const c = profile.capstone
  const [editing, setEditing] = useState(false)
  if (editing || !c) {
    return (
      <section className="project">
        <h3>Your project</h3>
        {!c && !editing && (
          <div className="col">
            <span className="small muted">A real task tied to your goal, with the route to it. Your tutor suggests one in your first lessons, or set one yourself.</span>
            <button onClick={() => setEditing(true)}>Set up a project</button>
          </div>
        )}
        {editing && <ProjectForm c={c} onDone={() => setEditing(false)} />}
      </section>
    )
  }
  const stage = stageOf(profile, c)
  const ms = milestones(profile, c)
  const met = ms.filter((x) => x.met).length
  return (
    <section className={`project ${stage}`}>
      <div className="row wrap">
        <h3>Your project</h3>
        <span className={`chip ${stage === 'done' ? 'ok' : ''}`}>{stage === 'done' ? '✓ done' : stage === 'final' ? 'final task open' : `${met} of ${ms.length} steps`}</span>
        <span className="spacer" />
        <button className="link small" onClick={() => setEditing(true)}>Change</button>
      </div>
      <div className="project-title">{titleOf(c)}</div>
      {c.why && <div className="small muted">{c.why}{c.setBy === 'tutor' ? ' (your tutor)' : ''}</div>}
      <ol className="route">
        {ms.map((x) => (
          <li key={x.skill} className={x.met ? 'met' : ''} title={x.met ? 'Reached, from your own answers' : 'Not yet: your tutor plans toward it'}>
            <span aria-hidden>{x.met ? '✓' : '○'}</span> {x.words}
          </li>
        ))}
        {!c.judge && <li className={stage === 'done' ? 'met' : ''}><span aria-hidden>{stage === 'done' ? '✓' : '★'}</span> The final task: {titleOf(c)}</li>}
      </ol>
      {stage !== 'done' && <UpNext profile={profile} />}
    </section>
  )
}

/** "Up next": the next step toward their project (or up on the tutor's plan), for the end of a lesson and the launcher. */
export function UpNext({ profile }: { profile: Profile }) {
  const line = upNext(profile)
  if (!line) return null
  return <div className="small up-next">{line}</div>
}

// Enough digits for sub-GHz projects too (13.56 MHz, 433.92 MHz) so "Keep" doesn't move them.
const GHZ = (hz?: number) => (hz ? String(+(hz / 1e9).toPrecision(7)) : '')


function ProjectForm({ c, onDone }: { c?: Capstone; onDone(): void }) {
  const datasets = useStudio((s) => s.datasets)
  const chartLoad = useStudio((s) => s.load)
  const z0 = useStudio((s) => s.z0)
  const designFreq = useStudio((s) => s.designFreq)
  const [f0, setF0] = useState(GHZ(c?.f0 ?? designFreq))
  const [banded, setBanded] = useState(!!c?.band)
  const [low, setLow] = useState(GHZ(c?.band?.low))
  const [high, setHigh] = useState(GHZ(c?.band?.high))
  const [vswr, setVswr] = useState(String(c?.maxVswr ?? 2))
  const [parts, setParts] = useState<CapstoneParts>(c?.parts ?? 'any')
  const [judge, setJudge] = useState(!!c?.judge)
  // 'keep', 'chart', or the name of one of their imported data sets.
  const [loadFrom, setLoadFrom] = useState<string>(c ? 'keep' : 'chart')
  const [err, setErr] = useState<string | null>(null)

  const chartAsProject = (): CapstoneLoad | null => {
    if (chartLoad.kind !== 'data') return chartLoad
    const ds = datasets.find((d) => d.id === chartLoad.datasetId)
    return ds ? { kind: 'data', datasetName: ds.name } : null
  }
  const ghz = (label: string, t: string) => {
    const v = Number(t.trim().replace(',', '.'))
    if (!t.trim() || !Number.isFinite(v) || v <= 0) throw new Error(`Enter the ${label} in GHz, e.g. 2.44.`)
    return v * 1e9
  }
  const save = async () => {
    try {
      const load: CapstoneLoad | null = judge ? c?.load ?? chartAsProject() ?? { kind: 'fixed', R: 50, X: 0 } // unused when judging
        : loadFrom === 'keep' && c ? c.load
          : loadFrom === 'chart' ? chartAsProject()
            : { kind: 'data', datasetName: loadFrom }
      if (!load) throw new Error('Import your data first (Load panel), or use the load on the chart.')
      const v = Number(vswr.trim().replace(',', '.'))
      const next = makeCapstone({
        load,
        // A judge project builds nothing: frequency and target don't apply, so they keep sensible values.
        f0: judge ? c?.f0 ?? designFreq : ghz('frequency', f0),
        band: !judge && banded ? { low: ghz('band low edge', low), high: ghz('band high edge', high) } : undefined,
        maxVswr: judge ? c?.maxVswr ?? 2 : v,
        parts, judge, z0,
        // Their own project now: the tutor's reason was for the old one.
        setBy: 'learner', at: new Date().toISOString()
      })
      const problem = capstoneProblem(next, datasets)
      if (problem) throw new Error(`That project can't work: ${problem}.`)
      await useApp.getState().updateProfile((p) => ({ ...p, capstone: next.judge && stageOf({ ...p, capstone: next }, next) === 'done' ? { ...next, done: { at: next.at } } : next }))
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="project-form col">
      <label className="row small" title="For interview prep or understanding: the project is judging worked matches, with no build"><input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} /> Judge worked solutions instead of building</label>
      {!judge && (
        <>
          <label className="row small">What to match
            <select value={loadFrom} onChange={(e) => setLoadFrom(e.target.value)} style={{ width: 'auto' }}>
              {c && <option value="keep">Keep: as now</option>}
              <option value="chart">The load on the chart now</option>
              {datasets.map((d) => <option key={d.id} value={d.name}>My data: {d.name}</option>)}
            </select>
          </label>
          <label className="row small">Frequency <input value={f0} onChange={(e) => setF0(e.target.value)} style={{ width: 80 }} /> GHz</label>
          <label className="row small"><input type="checkbox" checked={banded} onChange={(e) => setBanded(e.target.checked)} /> Across a band</label>
          {banded && (
            <div className="row small">
              <input value={low} onChange={(e) => setLow(e.target.value)} style={{ width: 70 }} aria-label="Band low edge (GHz)" /> –
              <input value={high} onChange={(e) => setHigh(e.target.value)} style={{ width: 70 }} aria-label="Band high edge (GHz)" /> GHz
            </div>
          )}
          <label className="row small">VSWR at most <input value={vswr} onChange={(e) => setVswr(e.target.value)} style={{ width: 56 }} /></label>
          <label className="row small">Parts
            <select value={parts} onChange={(e) => setParts(e.target.value as CapstoneParts)} style={{ width: 'auto' }}>
              <option value="any">Any</option>
              <option value="lumped">L and C</option>
              <option value="lines">A line and a stub</option>
            </select>
          </label>
        </>
      )}
      {err && <div className="grade fail small">{err}</div>}
      <div className="row">
        <button className="primary" onClick={save}>Save project</button>
        <button className="link" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}
