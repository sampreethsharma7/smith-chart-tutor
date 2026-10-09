import { useState } from 'react'
import { lessonsOf, skillChanges, skillName, type SessionRecord } from '@shared/profile'
import { useApp } from '@/state/app'
import { useTutor } from '@/agent/tutor'
import { startLesson } from '@/state/journey'
import { OutcomeBadge } from '@/components/LessonWrapUp'
import { forgetNote, misconceptionSignOff, topicDef } from '@shared/memory'
import { isLive, patternsOf, type Pattern } from '@shared/patterns'
import { SIGNOFF_WORDS, type SignOffStatus } from '@shared/signoff'
import { Standing } from '@/components/Standing'
import { ProjectCard } from '@/components/Project'

export function ProgressView() {
  const profile = useApp((s) => s.profile)!
  const { setView, updateProfile } = useApp.getState()
  const sessions = [...lessonsOf(profile)].reverse()
  const open = profile.misconceptions.filter((m) => !m.resolved)
  const resolved = profile.misconceptions.filter((m) => m.resolved)
  const recheck = resolved.filter((m) => misconceptionSignOff(profile, m).status === 'cleared').length
  const exercises = profile.sessions.flatMap((s) => s.exercises)

  return (
    <div className="page">
      <div className="row">
        <h2>{profile.name}'s progress</h2>
        <span className="spacer" />
        <button onClick={() => setView('assessment')}>{profile.assessment ? 'Retake placement test' : 'Take placement test'}</button>
      </div>

      <ProjectCard profile={profile} />

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
            {open.map((m) => {
              const so = misconceptionSignOff(profile, m)
              return (
              <li key={m.id}>
                <b>{skillName(m.skill)}</b> · seen {m.count}×{m.relapses ? ` · came back ${m.relapses}×` : ''}{' '}
                <span className={`chip pattern-status ${so.status}`} title={`Needs ${so.needed}. Why this bar: ${so.why}.`}>{SIGNOFF_WORDS[so.status]}</span><br />
                {m.description}{' '}
                <button className="link" onClick={() => updateProfile((p) => ({ ...p, misconceptions: p.misconceptions.map((x) => (x.id === m.id ? { ...x, resolved: true } : x)) }))}>mark resolved</button>
                <div className="muted small">Clears after: {so.needed} ({so.why}).</div>
              </li>
            )})}
          </ul>
          {resolved.length > 0 && <div className="muted small">{resolved.length} cleared{recheck ? `, ${recheck} still to re-check once in a later lesson` : ''}</div>}

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

const STATUS_TIP: Record<SignOffStatus, string> = {
  active: 'Seen recently: the tutor will work on the idea behind it',
  improving: 'Right answers on it in a later lesson, but not enough yet to call it cleared',
  cleared: 'Enough right answers in later lessons to clear it; one more in a later lesson confirms it',
  confirmed: 'Cleared, and it held in a later lesson. It comes back if it turns up again'
}

/**
 * The same confusion seen in different topics or lessons: what it is, the root idea,
 * and the evidence. Detected exactly from graded answers (and the tutor's notes).
 */
function Patterns({ patterns }: { patterns: Pattern[] }) {
  const [showGone, setShowGone] = useState(false)
  const live = patterns.filter(isLive)
  const gone = patterns.filter((x) => !isLive(x))
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
            <span className={`chip pattern-status ${x.status}`} title={STATUS_TIP[x.status]}>{SIGNOFF_WORDS[x.status]}</span>
          </div>
          <div className="small muted">Seen {x.slips.length}× in {x.topics.length} topic{x.topics.length === 1 ? '' : 's'}, over {x.lessons} lesson{x.lessons === 1 ? '' : 's'}{x.relapses ? `; came back ${x.relapses}× after being cleared` : ''}.</div>
          {x.status !== 'confirmed' && <div className="small muted">{x.status === 'cleared' ? 'To confirm' : 'Clears after'}: {x.signoff.needed} ({x.signoff.why}).</div>}
          <div className="small pattern-root"><span className="muted">The idea:</span> {x.root}</div>
          <ul className="plain small pattern-evidence">
            {x.slips.slice(-4).reverse().map((s, i) => (
              <li key={i}><span className="muted">{new Date(s.at).toLocaleDateString()} · {s.topic ? topicDef(s.topic)?.name : 'in conversation'}:</span> {s.detail}</li>
            ))}
          </ul>
        </div>
      ))}
      {gone.length > 0 && <button className="link small" onClick={() => setShowGone(!showGone)}>{showGone ? 'Hide' : 'Show'} {gone.length} cleared</button>}
    </>
  )
}
