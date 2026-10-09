import { Fragment, useState } from 'react'
import { COURSE_SCORES, DEFAULT_LESSONS, REQUESTS_PER_LESSON, type CourseReport } from '@shared/course'
import { useApp } from '@/state/app'
import { useCourse } from '@/state/course'
import { confirmDialog } from '@/components/Confirm'

const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`)
const heat = (v: number | undefined) => (v === undefined ? undefined : { background: `color-mix(in srgb, var(--accent) ${Math.round(v * 55)}%, transparent)` })

/**
 * Course run: the tutor teaches a scripted beginner for several lessons on a throwaway profile, and
 * code scores the teaching. Started only from here; each run is kept so runs and models can be compared.
 */
export function CourseRunCard() {
  const settings = useApp((s) => s.settings)
  const running = useCourse((s) => s.running)
  const lastNote = useCourse((s) => s.lastNote)
  const [providerId, setProviderId] = useState(settings.activeProviderId ?? settings.providers[0]?.id ?? '')
  const [lessons, setLessons] = useState(DEFAULT_LESSONS)
  const [seed, setSeed] = useState(1)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const provider = settings.providers.find((p) => p.id === providerId)
  const runs = [...(settings.courseRuns ?? [])].reverse()

  const start = async () => {
    if (!provider) return
    const ok = await confirmDialog(
      `Run ${lessons} lesson${lessons === 1 ? '' : 's'} with ${provider.label} teaching a scripted beginner? This uses about ${lessons * REQUESTS_PER_LESSON.low}–${lessons * REQUESTS_PER_LESSON.high} requests on that model and takes a while. ` +
      'The app switches to a throwaway learner profile while it runs (you can watch on Learn), then deletes it and comes back here. Your own profile and lessons are not touched.',
      { ok: 'Start the run' }
    )
    if (!ok) return
    setErr(null)
    setErr(await useCourse.getState().run({ providerId, lessons, seed }))
  }

  return (
    <section className="course-run">
      <h3>Course run</h3>
      <p className="muted small">
        Tests a model on whole lessons rather than single checks: it teaches a scripted beginner (not a model, so only the tutor uses requests) for several
        lessons, and the app scores the teaching from what happened: rising challenge, repeats, copied answers, leaks, loops and wrong physics.
        The same seed gives the same learner, so runs can be compared.
      </p>
      {running ? (
        <div className="note">
          <div><b>Running with {running.providerLabel}</b> · lesson {running.lesson || 1} of {running.of} · {running.requests} requests so far</div>
          <div className="muted small">{running.text}</div>
          <button onClick={() => useCourse.getState().stop()}>Stop</button>
        </div>
      ) : (
        <div className="row wrap">
          <label className="small">Model{' '}
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {settings.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="small" title="How many lessons the tutor teaches">Lessons{' '}
            <input type="number" min={1} max={12} value={lessons} style={{ width: 56 }} onChange={(e) => setLessons(Math.max(1, Math.min(12, Math.round(Number(e.target.value) || 1))))} />
          </label>
          <label className="small" title="The scripted learner's dice: the same seed gives the same learner">Seed{' '}
            <input type="number" min={1} value={seed} style={{ width: 64 }} onChange={(e) => setSeed(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
          </label>
          <button className="primary" disabled={!provider} onClick={start}>Start a course run</button>
          <span className="muted small">about {lessons * REQUESTS_PER_LESSON.low}–{lessons * REQUESTS_PER_LESSON.high} requests</span>
        </div>
      )}
      {err && <div className="grade fail">{err}</div>}
      {!running && lastNote && <div className={lastNote.error ? 'grade fail' : 'muted small'}>{lastNote.text}</div>}

      {runs.length > 0 && (
        <div className="table-scroll">
          <table className="compare heat">
            <thead>
              <tr>
                <th>When</th>
                <th>Model</th>
                <th title="Lessons finished / taught">Lessons</th>
                {COURSE_SCORES.map((d) => <th key={d.id} title={d.what}>{d.name}</th>)}
                <th title="Weighted over the scores measured">Overall</th>
                <th>Requests</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr className={open === r.id ? 'focus' : ''}>
                    <td className="small">{new Date(r.at).toLocaleString()}</td>
                    <td><div>{r.providerLabel}</div><div className="muted small">{r.model} · seed {r.seed}</div></td>
                    <td className="num">{r.facts.finished}/{r.lessons.length}</td>
                    {COURSE_SCORES.map((d) => <td key={d.id} className="cell" style={heat(r.scores[d.id])}>{pct(r.scores[d.id])}</td>)}
                    <td className="cell fit" style={heat(r.scores.overall)}><b>{pct(r.scores.overall)}</b></td>
                    <td className="num">{r.facts.requests}</td>
                    <td><button className="link small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'hide' : 'details'}</button></td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan={COURSE_SCORES.length + 6}><RunDetails r={r} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const ENDED: Record<CourseReport['lessons'][number]['ended'], string> = { goal: 'goal reached', cap: 'action limit', error: 'error', stopped: 'stopped' }

function RunDetails({ r }: { r: CourseReport }) {
  const f = r.facts
  const reading = Object.entries(f.reading).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'
  return (
    <div className="course-details small">
      {r.stopped && <div className="warn">{r.stopped}</div>}
      <ul>
        <li>{f.items} graded items; {f.correctShare === null ? '' : `${Math.round(f.correctShare * 100)}% right; `}{f.duplicates} repeat{f.duplicates === 1 ? '' : 's'}.</li>
        <li>Item level by lesson (0 easiest, 1 hardest): {f.levelByLesson.map((x) => (x === null ? '—' : x.toFixed(2))).join(' → ')}; independence steps gained: {f.stepsGained}.</li>
        <li>Reading answers by how the values were seen: {reading}.</li>
        {f.unsolved > 0 && <li>Tasks the scripted learner couldn't solve with the app's solvers (not counted against the tutor): {f.unsolved}.</li>}
        <li>Leaks {f.leaks}, claims of changes not made {f.claims}, refused tool calls {f.refusals}, loops {f.loops}, stretches without practice {f.stalls}, physics corrections {f.physicsFixes}.</li>
        {f.capstone && <li>Project: “{f.capstone.title}”: {f.capstone.met} of {f.capstone.total} steps{f.capstone.done ? ', done' : ''}.</li>}
        {!f.capstone && <li>No project was set.</li>}
        <li>{f.requests} requests, {f.tokens.toLocaleString()} tokens, {f.minutes} minutes.</li>
      </ul>
      <table className="compare">
        <thead><tr><th>#</th><th>Goal</th><th>Ended</th><th>Cards</th><th>Tasks</th><th>Actions</th><th>Requests</th></tr></thead>
        <tbody>
          {r.lessons.map((l) => (
            <tr key={l.n}>
              <td className="num">{l.n}</td>
              <td>{l.goal ?? <span className="muted">no goal set</span>}{l.error ? <div className="warn">{l.error}</div> : null}</td>
              <td>{ENDED[l.ended]}{l.recap ? '' : ' · no recap'}</td>
              <td className="num">{l.cards}</td>
              <td className="num">{l.tasks}</td>
              <td className="num">{l.actions}</td>
              <td className="num">{l.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="link small" onClick={async () => { if (await confirmDialog('Delete this course run from the list?', { ok: 'Delete', danger: true })) await useApp.getState().deleteCourseRun(r.id) }}>Delete this run</button>
    </div>
  )
}

/** Shown on every page while a run is going: the app is being driven. */
export function CourseRunBanner() {
  const running = useCourse((s) => s.running)
  if (!running) return null
  return (
    <div className="course-banner">
      <span>Course run in progress ({running.providerLabel}, lesson {running.lesson || 1} of {running.of}): the app is teaching a scripted learner. Please leave it alone until it finishes.</span>
      <button onClick={() => useCourse.getState().stop()}>Stop</button>
    </div>
  )
}
