import { memo, useEffect, useRef, useState } from 'react'
import type { Sure } from '@shared/profile'
import { useTutor, type DisplayItem } from '@/agent/tutor'
import { useStudio } from '@/state/studio'
import { activeProvider, useApp } from '@/state/app'
import { exerciseGoal } from '@/state/exercise'
import { answerQuestion, checkExercise, revealValues, skipQuestion, unsureQuestion } from '@/agent/answers'
import { Markdown } from '@/components/Markdown'
import { FlagButton } from '@/components/Flag'
import { parseComplex } from '@shared/rf/tasks'
import { gammaFromZ } from '@shared/rf/metrics'
import { SureButton, SureKey } from '@/components/SureButton'
import { LessonLauncher } from '@/components/LessonLauncher'
import { ELEMENT_LABEL } from '@shared/rf/network'
import { countsAsLesson } from '@shared/profile'
import { confirmDialog } from '@/components/Confirm'

export function TutorPanel() {
  const items = useTutor((s) => s.items)
  const busy = useTutor((s) => s.busy)
  const usage = useTutor((s) => s.usage)
  const historyLen = useTutor((s) => s.history.length)
  const { send, stop } = useTutor.getState()
  const settings = useApp((s) => s.settings)
  const provider = activeProvider()
  const bench = provider ? settings.benchmarks[provider.id] : undefined
  const [text, setText] = useState('')
  // A long lesson: draw the latest messages; earlier ones on request.
  const [shown, setShown] = useState(SHOWN)
  const hidden = Math.max(0, items.length - shown)
  const scroller = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [items])

  const submit = () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    send(t)
  }

  return (
    <aside className="tutor" ref={aside}>
      <ResizeHandle aside={aside} />
      <header className="tutor-head">
        <div>
          <b>Tutor</b>{' '}
          <span className="muted small">
            {provider ? provider.label : 'no model'}
            {bench && <span className={`tier tier-${bench.tier.toLowerCase()}`}>{bench.tier}</span>}
          </span>
        </div>
        <div className="row">
          <FinishButton />
        </div>
      </header>
      <LessonPlan />

      <div className="messages" ref={scroller}>
        {historyLen === 0 && <LessonLauncher key={useApp.getState().profile?.id} />}
        {hidden > 0 && (
          <button className="link earlier" onClick={() => setShown(shown + SHOWN)}>
            Show {Math.min(hidden, SHOWN)} earlier message{Math.min(hidden, SHOWN) === 1 ? '' : 's'}
          </button>
        )}
        {(hidden ? items.slice(hidden) : items).map((it) => <Message key={it.id} it={it} />)}
        {busy && !items.some((i) => i.streaming) && <div className="msg tutor"><span className="dots">thinking</span></div>}
      </div>

      <ExerciseCard />
      <PredictionCard />
      <GoalReachedBar />

      <div className="composer">
        <textarea
          placeholder={busy ? 'Tutor is thinking…' : historyLen ? 'Ask, explain your reasoning, or say what you tried…' : 'Or just ask a question to start…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
        />
        <div className="row">
          <span className="muted small">{usage.input + usage.output > 0 ? `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out tokens` : 'Enter to send · Shift+Enter for newline'}</span>
          <span className="spacer" />
          {busy ? <button onClick={stop}>Stop</button> : <button className="primary" onClick={submit} disabled={!provider}>Send</button>}
        </div>
      </div>
    </aside>
  )
}

const SHOWN = 150

/** One chat message. Memoised: while a reply streams in, only that message re-renders. */
export const Message = memo(function Message({ it, agent = 'tutor' }: { it: DisplayItem; agent?: 'tutor' | 'design' }) {
  return (
    <div className={`msg ${it.kind}`} title={it.model ? `Written by ${it.model}` : undefined}>
      {it.kind === 'tutor' && it.text && !it.streaming && <FlagButton agent={agent} itemId={it.id} />}
      {it.kind === 'tutor' ? (
        it.text ? <Markdown text={it.text} /> : <span className="dots">thinking</span>
      ) : it.kind === 'tool' ? (
        <span>⚙ {it.text}</span>
      ) : (
        <span>{it.text}</span>
      )}
    </div>
  )
})

/** The goal is reached: the lesson stays open to read back until they finish it, or keep going. */
function GoalReachedBar() {
  const s = useTutor((t) => t.session)
  const busy = useTutor((t) => t.busy)
  if (!s?.goalReachedAt || s.keptGoing) return null
  return (
    <div className="card goal-reached">
      <div className="row wrap">
        <b>🎉 Goal reached</b>
        <span className="muted small">Read back over the lesson as long as you like.</span>
      </div>
      <div className="row">
        <button onClick={() => useTutor.getState().keepGoing()} disabled={busy} title="Stay in this lesson: more practice, a harder one, or questions">Keep going</button>
        <span className="spacer" />
        <button className="primary" onClick={() => useTutor.getState().endSession()} disabled={busy} title="Write the summary, save the lesson and see how your skills moved">Finish lesson</button>
      </div>
    </div>
  )
}

/**
 * A lesson ends when the learner finishes it (after the goal, or early). This lets the
 * learner leave early: saved as partly done if they took part, dropped if not.
 * Closing the app only pauses a lesson.
 */
function FinishButton() {
  const session = useTutor((s) => s.session)
  const busy = useTutor((s) => s.busy)
  const inLesson = useTutor((s) => s.history.length > 0)
  if (!inLesson) return null
  const plan = session?.plan
  const engaged = !!session && countsAsLesson(session)
  const done = !!plan && plan.step >= plan.steps.length
  const finish = async () => {
    if (engaged && !done) {
      const where = plan ? ` (step ${plan.step + 1} of ${plan.steps.length})` : ''
      if (!(await confirmDialog(`Finish this lesson now?\n\nIt's saved as partly done${where} and the tutor picks up from there next time. To just take a break, leave it open: closing the app pauses the lesson.`, { ok: 'Finish lesson' }))) return
    }
    useTutor.getState().endSession()
  }
  return (
    <button
      onClick={finish}
      disabled={busy}
      className={done ? 'primary' : ''}
      title={!engaged ? "You haven't started yet: leaving won't save or count this lesson" : done ? 'Save the lesson and see what changed' : 'Save as partly done. Closing the app just pauses the lesson.'}
    >
      {!engaged ? 'Leave' : done ? 'Finish lesson' : 'Finish early'}
    </button>
  )
}

/** The lesson goal and its steps, ticked off by the tutor as the learner completes them. */
function LessonPlan() {
  const plan = useTutor((s) => s.session?.plan)
  const inLesson = useTutor((s) => s.history.length > 0)
  const [open, setOpen] = useState(true)
  if (!plan || !inLesson) return null
  const n = plan.steps.length
  const done = Math.min(plan.step, n)
  return (
    <div className="lesson-plan">
      <button className="lesson-goal" onClick={() => setOpen(!open)} title={open ? 'Hide steps' : 'Show steps'}>
        <span>🎯 {plan.goal}</span>
        <span className="muted small">{done}/{n} {open ? '▴' : '▾'}</span>
      </button>
      <div className="progressbar"><div style={{ width: `${n ? (done / n) * 100 : 0}%` }} /></div>
      {open && (
        <ol>
          {plan.steps.map((s, i) => (
            <li key={i} className={i < plan.step ? 'done' : i === plan.step ? 'current' : ''}>
              <span className="tick">{i < plan.step ? '✓' : i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const WIDTH_KEY = 'tutor.width'
const MIN_W = 300
/** Space kept between the chart's edge and the chat when the chat is widened. */
const CHART_GAP = 24

/**
 * Drag the chat's left edge to widen it. It can only take the empty space
 * beside the chart: the chart is a square sized by the smaller side of its
 * area, so while that area is wider than tall (plus a gap), the chart keeps
 * its size. Double-click resets. The width is remembered on this computer.
 */
export function ResizeHandle({ aside }: { aside: React.RefObject<HTMLElement | null> }) {
  const [dragging, setDragging] = useState(false)

  const grid = () => aside.current?.parentElement ?? null
  const apply = (w: number | null) => {
    if (w === null) grid()?.style.removeProperty('--tutor-w')
    else grid()?.style.setProperty('--tutor-w', `${Math.round(w)}px`)
  }
  /** Width the chat can still gain without shrinking the chart. */
  const slack = () => {
    const wrap = document.querySelector<HTMLElement>('.studio .chart-wrap')
    return wrap ? wrap.clientWidth - wrap.clientHeight - CHART_GAP : 0
  }
  const width = () => aside.current?.getBoundingClientRect().width ?? MIN_W

  useEffect(() => {
    let saved: number | null = null
    try {
      saved = Number(localStorage.getItem(WIDTH_KEY)) || null
    } catch { /* storage unavailable: use the default */ }
    if (saved) apply(saved)
    // Window got smaller: give the space back to the chart (never below the default width).
    const fit = () => {
      if (!grid()?.style.getPropertyValue('--tutor-w')) return
      const s = slack()
      if (s < 0) {
        const w = width() + s
        if (w <= 380) apply(null)
        else apply(w)
      }
    }
    const raf = requestAnimationFrame(fit)
    window.addEventListener('resize', fit)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* capture unavailable: dragging still works while over the handle */ }
    setDragging(true)
    const startX = e.clientX
    const startW = width()
    const target = e.currentTarget
    const move = (ev: PointerEvent) => {
      const want = startW + (startX - ev.clientX)
      const cur = width()
      // Growing is capped by the free space beside the chart, measured live.
      const w = want > cur ? Math.min(want, cur + Math.max(0, slack())) : Math.max(want, MIN_W)
      apply(w)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setDragging(false)
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(width())))
      } catch { /* not remembered; fine */ }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const reset = () => {
    apply(null)
    try {
      localStorage.removeItem(WIDTH_KEY)
    } catch { /* ignore */ }
  }

  return (
    <div
      className={`tutor-resize ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      title="Drag to resize the chat · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  )
}

function ExerciseCard() {
  const ex = useStudio((s) => s.exercise)
  const busy = useTutor((s) => s.busy)
  const [last, setLast] = useState<string | null>(null)
  useEffect(() => setLast(null), [ex?.id])
  if (!ex) return null
  const reach = ex.kind === 'reach'

  const check = () => {
    const g = checkExercise()
    if (g) setLast(g.summary)
  }

  return (
    <div className={`card exercise ${ex.status}`}>
      <div className="row">
        <b>🎯 {ex.title}</b>
        <span className="spacer" />
        <button className="icon" title="Dismiss" onClick={() => useStudio.getState().setExercise(null)}>×</button>
      </div>
      <Markdown text={ex.instructions} />
      <div className="muted small">
        Goal: {exerciseGoal(ex)}
        {ex.maxElements ? ` · max ${ex.maxElements} element${ex.maxElements > 1 ? 's' : ''}` : ''}
        {ex.allowedKinds?.length ? ` · allowed: ${ex.allowedKinds.map((k) => ELEMENT_LABEL[k]).join(', ')}` : ''}
      </div>
      {last && <div className={`grade ${last.startsWith('PASS') ? 'pass' : 'fail'}`}>{last}</div>}
      <div className="row">
        <button className="primary" onClick={check} disabled={busy}>
          {ex.status === 'passed' ? 'Passed ✓ · check again' : reach ? 'Check' : 'Check my match'}
        </button>
        <span className="muted small">attempts: {ex.attempts}</span>
      </div>
    </div>
  )
}

function PredictionCard() {
  const p = useStudio((s) => s.prediction)
  const busy = useTutor((s) => s.busy)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  // Two-part questions: the answer first, then why (the reason carries how sure they are).
  const [first, setFirst] = useState<string | null>(null)
  useEffect(() => { setText(''); setErr(null); setFirst(null) }, [p?.id])
  if (!p) return null
  const graded = !!p.key
  const reasons = p.key?.type === 'move' ? p.key.reasons : undefined
  // A reading question with the values covered (reading.ts): no typed point, no clicked value.
  const covered = p.values === 'covered' && !p.revealed

  // One click answers and says how sure they are (where on the button they clicked).
  const answer = (a: string, sure?: Sure, reason?: string) => {
    const problem = answerQuestion(a, sure, reason)
    setErr(problem)
    if (problem) setFirst(null)
  }
  // A plain function, not a component: a component defined here would remount (and lose its hover) on every render.
  const choice = (key: number, label: string, onPick: (sure: Sure | undefined) => void) =>
    graded ? <SureButton key={key} onPick={onPick} disabled={busy}>{label}</SureButton> : <button key={key} onClick={() => onPick(undefined)} disabled={busy}>{label}</button>

  return (
    <div className={`card prediction ${graded ? 'graded' : ''}`}>
      <div className="row">
        <b>{graded ? '🧩 Question' : '🤔 Predict first'}</b>
        {p.followUp && <span className="muted small">about your solution · optional</span>}
      </div>
      <Markdown text={p.question} />
      {p.kind === 'mcq' && reasons && first !== null ? (
        <div className="why-step">
          <div className="small"><span className="muted">Your answer:</span> <b>{first}</b> <button className="link small" onClick={() => setFirst(null)} disabled={busy}>change</button></div>
          <div className="small"><b>Why?</b></div>
          <SureKey />
          <div className="choices">
            {reasons.choices.map((c, i) => choice(i, c, (sure) => answer(first, sure, c)))}
          </div>
        </div>
      ) : p.kind === 'mcq' ? (
        <>
          {graded && !reasons && <SureKey />}
          <div className="choices">
            {(p.choices ?? []).map((c, i) =>
              reasons
                // The first part of a two-part question: just the answer; the reason will carry the confidence.
                ? <button key={i} onClick={() => { setErr(null); setFirst(c) }} disabled={busy}>{c}</button>
                : choice(i, c, (sure) => answer(c, sure))
            )}
          </div>
        </>
      ) : null}
      {p.kind === 'click' && (
        <div>
          {/* Always there for keyboard users; on a reading question a typed point counts partly (it copies the question's z). */}
          <TypedPoint onPoint={(g, z) => useStudio.getState().setPrediction({ ...p, answered: `typed z = ${z}`, answeredGamma: g, typed: true })} disabled={busy} />
          {p.values && <span className="muted small">Typing the point counts partly; finding it on the chart counts fully.</span>}
          {p.answered ? (
            <div className="col">
              <span className="small">{covered && !p.typed ? 'Point chosen (marked on the chart); its value shows after you submit.' : p.answered}</span>
              {graded && <SureKey />}
              {graded
                ? <SureButton className="primary wide" onPick={(sure) => answer(p.answered!, sure)} disabled={busy}>Submit</SureButton>
                : <button className="primary" onClick={() => answer(p.answered!)} disabled={busy}>Submit</button>}
            </div>
          ) : (
            <span className="muted small">Click your answer on the chart{p.key ? '; you can click again to change it' : ''}.</span>
          )}
        </div>
      )}
      {p.kind === 'text' && (
        <div className="col">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && text.trim() && answer(text.trim())}
            disabled={busy}
            placeholder={p.hint ?? (graded ? 'Your answer…' : 'Your prediction…')}
          />
          {graded && <SureKey />}
          {graded
            ? <SureButton className="primary wide" onPick={(sure) => text.trim() && answer(text.trim(), sure)} disabled={busy}>Submit</SureButton>
            : <button className="primary" onClick={() => text.trim() && answer(text.trim())} disabled={busy}>Submit</button>}
        </div>
      )}
      {err && <div className="grade fail">{err}</div>}
      {covered && (
        <div className="covered-note">
          The values are covered: read this from the chart.{' '}
          <button className="link small" onClick={revealValues} disabled={busy} title="Uncover the readout, hover values and tables. Your answer then counts as partly right, since the number was on screen.">Show values</button>
        </div>
      )}
      {p.values === 'covered' && p.revealed && <div className="muted small">Values shown: this answer counts as partly right.</div>}
      {p.values === 'shown' && <div className="muted small">The values are on screen for this one, so it counts as partly right. Soon you'll read them from the chart.</div>}
      <div className="row">
        <button className="link" onClick={unsureQuestion} disabled={busy}>{graded ? 'Help me think it through' : "I'm not sure"}</button>
        {graded && <button className="link" onClick={skipQuestion} disabled={busy}>Skip this question</button>}
      </div>
    </div>
  )
}

/** For "click on the chart" questions: type the point instead (keyboard users, or a precise value). */
function TypedPoint({ onPoint, disabled }: { onPoint(g: { re: number; im: number }, zText: string): void; disabled?: boolean }) {
  const [t, setT] = useState('')
  const [bad, setBad] = useState(false)
  const go = () => {
    const z = parseComplex(t)
    if (!z || z.re < 0) return setBad(true)
    setBad(false)
    onPoint(gammaFromZ(z, 1), `${z.re} ${z.im < 0 ? '−' : '+'} j${Math.abs(z.im)}`)
  }
  return (
    <label className="typed-point small muted" title="Or type the point as z, e.g. 0.5 + j1, and press Enter">
      or type z:
      <input className={bad ? 'bad' : ''} value={t} disabled={disabled} placeholder="e.g. 0.5 + j1" onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
    </label>
  )
}
