import { useState } from 'react'
import { hasReviewMaterial, lessonsOf, skillName, SKILLS, type SkillId } from '@shared/profile'
import { useTutor } from '@/agent/tutor'
import { activeProvider, useApp } from '@/state/app'
import { modelReady, startLesson } from '@/state/journey'
import { LessonWrapUp } from './LessonWrapUp'
import { UpNext } from './Project'

type Choice = 'auto' | 'own' | 'probe' | SkillId

/**
 * What the tutor panel shows between lessons: how the last one went, and the
 * one button that starts the next.
 */
export function LessonLauncher() {
  const profile = useApp((s) => s.profile)!
  useApp((s) => s.settings) // re-render when a model is connected
  const setView = useApp((s) => s.setView)
  const lastEnded = useTutor((s) => s.lastEnded)
  const notice = useTutor((s) => s.notice)
  const [choice, setChoice] = useState<Choice>('auto')
  const [more, setMore] = useState(false)

  const ready = modelReady()
  const provider = activeProvider()
  const n = lessonsOf(profile).length + 1
  // The tutor's plan (set_next_focus) is the one source of what's suggested.
  const plan = profile.nextFocus?.picks ?? []
  const focus = plan.map((x) => x.skill)
  const why = (id: SkillId) => plan.find((x) => x.skill === id)?.why
  const last = lastEnded ?? [...lessonsOf(profile)].reverse().find((s) => s.summary)
  const open = profile.misconceptions.filter((m) => !m.resolved).length
  const draft = profile.assessmentDraft
  const others = SKILLS.filter((s) => !focus.includes(s.id))

  return (
    <div className="lesson-launcher">
      {lastEnded && <LessonWrapUp s={lastEnded} n={n - 1} />}
      {notice && <div className="small muted">{notice}</div>}

      <h4>{n === 1 ? 'Your first lesson' : `Lesson ${n}`}</h4>
      {!lastEnded && last?.summary && (
        <p className="summary"><span className="muted small">Last time: </span>{last.summary}</p>
      )}
      {/* What this lesson moves them toward (their project, or the next step up): the wrap-up shows it when there is one. */}
      {!lastEnded && <UpNext profile={profile} />}
      {n === 1 && (
        <p className="small">
          The tutor sets a goal for the lesson, gives you tasks on this chart, asks you to predict before you check, and nudges you when you're stuck.
          The lesson ends when you reach the goal, with no clock. You can finish early any time; it's summarised so the next lesson picks up from there.
        </p>
      )}

      <div className="small muted">Work on</div>
      <div className="focus-choices">
        <label className={choice === 'auto' ? 'on' : ''}>
          <input type="radio" checked={choice === 'auto'} onChange={() => setChoice('auto')} />
          <span>
            Tutor's pick <span className="muted small">
              {plan.length ? `(continues its plan: ${skillName(plan[0].skill)})` : profile.assessment ? '(from your test and progress)' : open ? '(from your progress)' : '(it will gauge your level)'}
            </span>
          </span>
        </label>
        {[...focus, ...(more ? others.map((s) => s.id) : [])].map((id) => (
          <label key={id} className={choice === id ? 'on' : ''}>
            <input type="radio" checked={choice === id} onChange={() => setChoice(id)} />
            <span title={why(id)}>{skillName(id)} {focus.includes(id) && <span className="muted small">· in your tutor's plan</span>}</span>
          </label>
        ))}
        {!more && others.length > 0 && <button className="link small" onClick={() => setMore(true)}>Other topics…</button>}
        {lessonsOf(profile).length > 0 && (
          <label className={choice === 'probe' ? 'on' : ''} title="5–6 graded questions in a row on what looks strong but isn't proven yet. No teaching: it finds out what really holds.">
            <input type="radio" checked={choice === 'probe'} onChange={() => setChoice('probe')} />
            <span>Check yourself <span className="muted small">(about 5 minutes: what do I really know?)</span></span>
          </label>
        )}
        <label className={choice === 'own' ? 'on' : ''}>
          <input type="radio" checked={choice === 'own'} onChange={() => setChoice('own')} />
          <span>My own question or design problem</span>
        </label>
      </div>

      {hasReviewMaterial(profile) && choice !== 'own' && choice !== 'probe' && (
        <label className="review-opt" title="One quick question on something from earlier lessons; skip it any time. Remembered for next time.">
          <input
            type="checkbox"
            checked={!!profile.preferences.reviewFirst}
            onChange={(e) => useApp.getState().updateProfile((p) => ({ ...p, preferences: { ...p.preferences, reviewFirst: e.target.checked } }))}
          />
          <span>Start with a quick review question <span className="muted">(optional, helps it stick)</span></span>
        </label>
      )}
      <button className="primary big" onClick={() => startLesson(choice === 'auto' ? undefined : choice)} disabled={!ready}>
        ▶ Start {n === 1 ? 'your first lesson' : 'lesson'}
      </button>
      {!ready && (
        <p className="small warn">
          {provider ? `${provider.label} needs an API key.` : 'Connect a tutor model first.'}{' '}
          <button className="link" onClick={() => setView('models')}>Open Models</button>
        </p>
      )}
      {open > 0 && <div className="small muted">{open} open misconception{open > 1 ? 's' : ''}: the tutor will revisit {open > 1 ? 'them' : 'it'}.</div>}
      {draft && (
        <div className="small warn">
          Placement test paused at question {draft.idx + 1}. <button className="link" onClick={() => setView('assessment')}>Resume</button>
        </div>
      )}
      <p className="muted small">Or explore the chart on your own: everything on the left works without the tutor.</p>
    </div>
  )
}
