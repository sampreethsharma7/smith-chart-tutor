import { useState } from 'react'
import { lessonsOf, skillChanges, skillName, type SessionRecord } from '@shared/profile'
import { useApp } from '@/state/app'
import { useTutor } from '@/agent/tutor'
import { startLesson } from '@/state/journey'
import { OutcomeBadge } from '@/components/LessonWrapUp'
import { forgetNote, topicDef } from '@shared/memory'
import { patternsOf, type Pattern } from '@shared/patterns'
import { Standing } from '@/components/Standing'

export function ProgressView() {
  const profile = useApp((s) => s.profile)!
  const { setView, updateProfile } = useApp.getState()
  const sessions = [...lessonsOf(profile)].reverse()
  const open = profile.misconceptions.filter((m) => !m.resolved)
  const resolved = profile.misconceptions.filter((m) => m.resolved)
  const exercises = profile.sessions.flatMap((s) => s.exercises)

  return (
    <div className="page">
      <div className="row">
        <h2>{profile.name}'s progress</h2>
        <span className="spacer" />
        <button onClick={() => setView('assessment')}>{profile.assessment ? 'Retake placement test' : 'Take placement test'}</button>
      </div>

      <Standing profile={profile} />

      <div className="tiles three">
        <div className="tile"><div className="tile-num">{sessions.length}</div><div className="muted small">{sessions.length === 1 ? 'lesson' : 'lessons'}</div></div>
        <div className="tile"><div className="tile-num">{exercises.filter((e) => e.passed).length}/{exercises.length}</div><div className="muted small" title="Tasks (matching, reaching a target) and graded questions, checked by the app">tasks &amp; questions right</div></div>
        <div className="tile"><div className="tile-num">{open.length}</div><div className="muted small">open misconceptions</div></div>
      </div>

      <div className="cols">
        <div>
          <Patterns patterns={patternsOf(profile)} />
          <h3>Misconceptions</h3>
          {open.length === 0 && <div className="muted small">None open.</div>}
          <ul className="plain">
            {open.map((m) => (
              <li key={m.id}>
                <b>{skillName(m.skill)}</b> · seen {m.count}×{m.topic ? ' · closes itself after right answers in two lessons' : ''}<br />
                {m.description}{' '}
                <button className="link" onClick={() => updateProfile((p) => ({ ...p, misconceptions: p.misconceptions.map((x) => (x.id === m.id ? { ...x, resolved: true } : x)) }))}>mark resolved</button>
              </li>
            ))}
          </ul>
          {resolved.length > 0 && <div className="muted small">{resolved.length} resolved</div>}

          <h3>Tutor's notes about you</h3>
          <p className="muted small">What the tutor keeps in mind beyond your answers. Delete anything that's wrong or out of date.</p>
          {(profile.notes ?? []).length === 0 && <div className="muted small">The tutor hasn't saved notes yet.</div>}
          <ul className="plain small">
            {[...(profile.notes ?? [])].reverse().map((n) => (
              <li key={n.id}>
                <span className="chip">{n.category}</span> {n.text}{' '}
                <button className="link" title="Delete this note" onClick={() => updateProfile((p) => forgetNote(p, n.id))}>delete</button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>Lessons</h3>
          {sessions.length === 0 && <div className="muted small">No lessons yet. <button className="link" onClick={() => startLesson()}>Start your first lesson</button></div>}
          {sessions.map((s, i) => <SessionItem key={s.id} s={s} n={sessions.length - i} />)}
        </div>
      </div>
    </div>
  )
}

function SessionItem({ s, n }: { s: SessionRecord; n: number }) {
  const [open, setOpen] = useState(false)
  const inProgress = useTutor((t) => t.session?.id === s.id && t.history.length > 0)
  return (
    <div className="session">
      <div className="row">
        <b>Lesson {n}</b>
        {inProgress ? <span className="chip">in progress</span> : <OutcomeBadge s={s} />}
        <span className="muted small">
          {new Date(s.startedAt).toLocaleString()} · {(s.models?.length ?? 0) > 1 ? `${s.models!.join(' → ')} · ` : s.provider ? `${s.provider} · ` : ''}{s.focus && s.focus !== 'own' ? `${skillName(s.focus)} · ` : ''}{s.messageCount ?? s.transcript.length} messages · {s.exercises.length} tasks &amp; questions
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'hide' : 'transcript'}</button>
      </div>
      {s.plan && <div className="small"><span className="muted">Goal:</span> {s.plan.goal}</div>}
      <div className="small">{s.summary ?? <span className="muted">{inProgress ? 'In progress: a summary is written when the lesson ends.' : 'No summary yet; one is written next time you start a lesson.'}</span>}</div>
      {!inProgress && <SkillMoves s={s} />}
      {s.exercises.length > 0 && (
        <div className="small">{s.exercises.map((e, i) => <span key={i} className={`chip ${e.passed ? 'ok' : ''}`}>{e.passed ? '✓' : '✗'} {e.title}</span>)}</div>
      )}
      {open && (
        <div className="transcript">
          {s.transcript.map((t, i) => (
            <div key={i} className={`t-${t.role}`}>
              <b>{t.role === 'user' ? 'You' : 'Tutor'}</b>{t.role === 'tutor' && t.model && (s.models?.length ?? 0) > 1 ? <span className="muted"> ({t.model})</span> : null}<b>:</b> {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Compact "what moved" line for a past lesson. */
function SkillMoves({ s }: { s: SessionRecord }) {
  const skills = useApp((st) => st.profile!.skills)
  const changes = skillChanges(s, skills).slice(0, 3)
  if (!s.skillsAtEnd || changes.length === 0) return null
  return (
    <div className="small">
      {changes.map((c) => {
        const d = Math.round((c.to - c.from) * 100)
        return <span key={c.id} className={`chip ${d >= 0 ? 'ok' : ''}`}>{skillName(c.id)} {d >= 0 ? '+' : ''}{d}</span>
      })}
    </div>
  )
}

const STATUS_WORD: Record<Pattern['status'], string> = { active: 'active', fading: 'fading', gone: 'gone' }
const STATUS_TIP: Record<Pattern['status'], string> = {
  active: 'Seen recently: the tutor will work on the idea behind it',
  fading: 'Right answers on it in one lesson since it was last seen; one more lesson like that and it is gone',
  gone: 'Right answers on it in two lessons since it was last seen; it comes back if it turns up again'
}

/**
 * The same confusion seen in different topics or lessons: what it is, the root idea,
 * and the evidence. Detected exactly from graded answers (and the tutor's notes).
 */
function Patterns({ patterns }: { patterns: Pattern[] }) {
  const [showGone, setShowGone] = useState(false)
  const live = patterns.filter((x) => x.status !== 'gone')
  const gone = patterns.filter((x) => x.status === 'gone')
  return (
    <>
      <h3>Patterns the tutor has noticed</h3>
      <p className="muted small">The same kind of mistake turning up in different places. Fixing the idea behind it clears all of them at once.</p>
      {live.length === 0 && <div className="muted small">{patterns.length ? 'None active.' : 'None yet. When the same kind of mistake turns up in two topics or two lessons, it shows here.'}</div>}
      {[...live, ...(showGone ? gone : [])].map((x) => (
        <div key={x.confusion} className={`pattern ${x.status}`}>
          <div className="row">
            <b>{x.name}</b>
            <span className="spacer" />
            <span className={`chip pattern-status ${x.status}`} title={STATUS_TIP[x.status]}>{STATUS_WORD[x.status]}</span>
          </div>
          <div className="small muted">Seen {x.slips.length}× in {x.topics.length} topic{x.topics.length === 1 ? '' : 's'}, over {x.lessons} lesson{x.lessons === 1 ? '' : 's'}.</div>
          <div className="small pattern-root"><span className="muted">The idea:</span> {x.root}</div>
          <ul className="plain small pattern-evidence">
            {x.slips.slice(-4).reverse().map((s, i) => (
              <li key={i}><span className="muted">{new Date(s.at).toLocaleDateString()} · {s.topic ? topicDef(s.topic)?.name : 'in conversation'}:</span> {s.detail}</li>
            ))}
          </ul>
        </div>
      ))}
      {gone.length > 0 && <button className="link small" onClick={() => setShowGone(!showGone)}>{showGone ? 'Hide' : 'Show'} {gone.length} gone</button>}
    </>
  )
}
