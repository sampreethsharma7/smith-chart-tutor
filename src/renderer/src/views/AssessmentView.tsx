import { useState } from 'react'
import { shuffledQuestions, grade, parseNumericAnswer, scoreAssessment, type Answer, type Question } from '@shared/assessment'
import { lessonsOf, skillName, SKILLS, type AssessmentDraft } from '@shared/profile'
import type { Complex } from '@shared/rf/complex'
import { useApp } from '@/state/app'
import { modelReady, startLesson } from '@/state/journey'
import { ChartBase } from '@/chart/ChartBase'
import { sx, sy } from '@/chart/geometry'

/**
 * Placement test. All progress lives in `profile.assessmentDraft` and is saved
 * after every answer, so switching tabs, switching profiles or closing the app
 * never loses it.
 */
export function AssessmentView() {
  const profile = useApp((s) => s.profile)!
  const { updateProfile, setView } = useApp.getState()
  const draft = profile.assessmentDraft
  const [saving, setSaving] = useState(false)

  const patchDraft = (fn: (d: AssessmentDraft) => AssessmentDraft | undefined) =>
    updateProfile((p) => (p.assessmentDraft ? { ...p, assessmentDraft: fn(p.assessmentDraft) } : p))

  const start = () =>
    updateProfile((p) => ({
      ...p,
      assessmentDraft: { questions: shuffledQuestions(), idx: 0, answers: [], feedback: null, shownAt: Date.now(), startedAt: new Date().toISOString() }
    }))

  if (!draft) return <Intro onStart={start} />

  const q = draft.questions[draft.idx]
  const total = draft.questions.length

  const submit = (value: Answer['value']) => {
    if (draft.feedback) return
    patchDraft((d) => ({
      ...d,
      answers: [...d.answers.filter((a) => a.questionId !== q.id), { questionId: q.id, value, ms: Date.now() - d.shownAt }],
      feedback: { ok: grade(q, value), skipped: value === null }
    }))
  }

  const next = async () => {
    if (draft.idx + 1 < total) {
      await patchDraft((d) => ({ ...d, idx: d.idx + 1, feedback: null, shownAt: Date.now() }))
      return
    }
    setSaving(true)
    await updateProfile((p) => {
      const { result, skills } = scoreAssessment(draft.questions, draft.answers, p)
      return { ...p, skills, assessment: result, assessmentDraft: undefined }
    })
    setSaving(false)
  }

  const answer = draft.answers.find((a) => a.questionId === q.id)

  return (
    <div className="page narrow">
      <div className="row">
        <div className="progressbar grow"><div style={{ width: `${((draft.idx + (draft.feedback ? 1 : 0)) / total) * 100}%` }} /></div>
        <button className="link" onClick={() => setView('studio')} title="Your answers are saved; resume any time from here or the Get started bar">Pause</button>
        <button
          className="link danger"
          onClick={() => window.confirm('Discard this placement test? Answers so far will be lost.') && updateProfile((p) => ({ ...p, assessmentDraft: undefined }))}
        >
          Discard
        </button>
      </div>
      <div className="muted small">Question {draft.idx + 1} of {total} · {skillName(q.skill)} · progress is saved automatically</div>
      <h3 className="question">{q.prompt}</h3>
      <QuestionInput key={q.id} q={q} answered={draft.feedback ? answer?.value ?? null : undefined} onSubmit={submit} />
      {!draft.feedback && <button className="link" onClick={() => submit(null)}>I don’t know</button>}
      {draft.feedback && (
        <div className={`grade ${draft.feedback.ok ? 'pass' : 'fail'}`}>
          <div><b>{draft.feedback.ok ? 'Correct.' : draft.feedback.skipped ? 'No problem.' : 'Not quite.'}</b> {q.explain}</div>
          <div><button className="primary" onClick={next} disabled={saving} autoFocus>{draft.idx + 1 < total ? 'Next' : 'See results'}</button></div>
        </div>
      )}
    </div>
  )
}

function Intro({ onStart }: { onStart(): void }) {
  const profile = useApp((s) => s.profile)!
  const setView = useApp((s) => s.setView)
  useApp((s) => s.settings) // re-render when a model is connected
  const result = profile.assessment
  const plan = profile.nextFocus?.picks ?? []
  const ready = modelReady()
  return (
    <div className="page narrow">
      {result ? (
        <>
          <h2>Starting level: {result.level}</h2>
          <p className="muted small">Placement test taken {new Date(result.takenAt).toLocaleString()}. The tutor keeps adjusting these estimates as it watches you work. See Progress for the current ones.</p>
          <div className="skill-bars">
            {SKILLS.map((s) => {
              const ps = result.perSkill[s.id]
              if (!ps) return null
              return (
                <div key={s.id} className="skill-bar" title={`${ps.correct} of ${ps.total} correct`}>
                  <span>{s.name}</span>
                  <div className="bar"><div style={{ width: `${(ps.correct / ps.total) * 100}%` }} /></div>
                  <span className="num">{ps.correct}/{ps.total}</span>
                </div>
              )
            })}
          </div>
          <div className="next-step">
            <div>
              <b>Next: {lessonsOf(profile).length ? 'a lesson' : 'your first lesson'}.</b>{' '}
              {plan.length > 0
                ? <>Your tutor's plan: <b>{plan.map((x) => skillName(x.skill)).join(', ')}</b>. </>
                : <>Your tutor plans where to start from these results. </>}
              It sets a goal, gives you tasks on the chart and checks your work.
              {!ready && <span className="warn"> First connect a tutor model in Models.</span>}
            </div>
            <div className="row">
              <button className="primary big" onClick={() => startLesson()}>
                {ready ? `▶ Start ${lessonsOf(profile).length ? 'a lesson' : 'your first lesson'}` : 'Connect a model'}
              </button>
              <button onClick={() => setView('progress')}>See progress</button>
              <span className="spacer" />
              <button onClick={onStart}>Retake test</button>
            </div>
          </div>
        </>
      ) : (
        <>
          <h2>Placement test</h2>
          <p>
            21 short questions across {SKILLS.length} skills, about 10 minutes. The result sets your starting level so the tutor pitches tasks right.
            The tutor keeps adjusting it as it watches you work.
          </p>
          <p className="muted">
            Choose <b>“I don’t know”</b> rather than guessing. A lucky guess makes the tutor skip things you need.
            You’ll see a short explanation after each answer. You can pause any time; progress is saved.
          </p>
          <div className="row">
            <button className="primary big" onClick={onStart}>Start the test</button>
            <button
              className="link"
              onClick={() => useApp.getState().updateProfile((p) => ({ ...p, skippedAssessment: true })).then(() => setView('studio'))}
              title="The tutor will gauge your level with a few questions during your first lesson"
            >
              Skip, let the tutor gauge me
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function QuestionInput({ q, answered, onSubmit }: { q: Question; answered: Answer['value'] | undefined; onSubmit(v: Answer['value']): void }) {
  const done = answered !== undefined
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Complex | null>(null)

  if (q.kind === 'mcq') {
    return (
      <div className="choices vertical">
        {q.choices.map((c, i) => (
          <button
            key={i}
            disabled={done}
            className={done && i === q.answer ? 'correct' : done && i === answered ? 'wrong' : ''}
            onClick={() => onSubmit(i)}
          >
            {c}
          </button>
        ))}
      </div>
    )
  }
  if (q.kind === 'numeric') {
    const go = () => {
      const v = parseNumericAnswer(text)
      if (!Number.isFinite(v)) {
        setErr('Enter a number (units are optional).')
        return
      }
      setErr(null)
      onSubmit(v)
    }
    return (
      <div>
        <div className="row">
          <input
            autoFocus
            value={done && typeof answered === 'number' ? String(answered) : text}
            disabled={done}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="Your answer"
          />
          {q.unit && <span>{q.unit}</span>}
          <button className="primary" disabled={done} onClick={go}>Submit</button>
        </div>
        {err && <div className="error">{err}</div>}
        {done && <div className="muted small">Expected {q.answer}{q.unit ? ` ${q.unit}` : ''} (±{q.tol})</div>}
      </div>
    )
  }
  const shown = done && answered && typeof answered === 'object' ? answered : picked
  return (
    <div className="quiz-chart">
      <ChartBase wtgScale={false} onPick={(g) => !done && setPicked(g)}>
        {q.show && <circle cx={sx(q.show)} cy={sy(q.show)} r={0.025} className="quiz-show" />}
        {done && <circle cx={sx(q.target)} cy={sy(q.target)} r={q.tol} className="quiz-target" />}
        {shown && <circle cx={sx(shown)} cy={sy(shown)} r={0.02} className="quiz-pick" />}
      </ChartBase>
      <div className="row">
        <span className="muted small">{done ? 'Green = correct region.' : picked ? 'Click again to move it, then submit.' : 'Click on the chart.'}</span>
        <span className="spacer" />
        <button className="primary" disabled={!picked || done} onClick={() => onSubmit(picked)}>Submit</button>
      </div>
    </div>
  )
}
