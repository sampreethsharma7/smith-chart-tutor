import { skillChanges, skillName, type SessionRecord } from '@shared/profile'
import { useApp } from '@/state/app'

export function OutcomeBadge({ s }: { s: SessionRecord }) {
  if (s.outcome === 'completed') return <span className="chip ok">✓ goal reached</span>
  if (s.outcome === 'partial') {
    const p = s.plan
    return <span className="chip">{p ? `partly done · ${Math.min(p.step, p.steps.length)}/${p.steps.length} steps` : 'finished early'}</span>
  }
  return null
}

/** What a lesson achieved: the goal, the tutor's recap and how the learner's skills moved. */
export function LessonWrapUp({ s, n }: { s: SessionRecord; n: number }) {
  const skills = useApp((st) => st.profile!.skills)
  const setView = useApp((st) => st.setView)
  const changes = skillChanges(s, skills)
  const passed = s.exercises.filter((e) => e.passed).length
  return (
    <div className={`lesson-done ${s.outcome === 'completed' ? 'completed' : ''}`}>
      <div className="row wrap">
        <b>{s.outcome === 'completed' ? `🎉 Lesson ${n} complete` : `Lesson ${n} saved`}</b>
        <OutcomeBadge s={s} />
      </div>
      {s.plan && <div className="small"><span className="muted">Goal:</span> {s.plan.goal}</div>}
      {s.recap && s.recap.canNowDo.length > 0 && (
        <div className="small">
          <div className="muted">You can now:</div>
          <ul className="recap">{s.recap.canNowDo.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {changes.length > 0 && (
        <div className="skill-deltas">
          {changes.slice(0, 4).map((c) => {
            const d = Math.round((c.to - c.from) * 100)
            return (
              <div key={c.id} className="skill-delta" title={`${Math.round(c.from * 100)}% → ${Math.round(c.to * 100)}%`}>
                <span>{skillName(c.id)}</span>
                <div className="bar">
                  <div className="from" style={{ width: `${Math.min(c.from, c.to) * 100}%` }} />
                  <div className={d >= 0 ? 'gain' : 'loss'} style={{ left: `${Math.min(c.from, c.to) * 100}%`, width: `${Math.abs(c.to - c.from) * 100}%` }} />
                </div>
                <span className={`num ${d >= 0 ? 'ok' : 'warn'}`}>{d >= 0 ? '+' : ''}{d}</span>
              </div>
            )
          })}
        </div>
      )}
      {changes.length === 0 && <div className="small muted">No skill estimates changed this time: the tutor needs to see you work a little more.</div>}
      {s.exercises.length > 0 && <div className="small">{passed} of {s.exercises.length} task{s.exercises.length > 1 ? 's' : ''} and question{s.exercises.length > 1 ? 's' : ''} right</div>}
      {s.recap?.practiseNext && <div className="small"><span className="muted">Next:</span> {s.recap.practiseNext}</div>}
      <button className="link" onClick={() => setView('progress')}>See all your progress</button>
    </div>
  )
}
