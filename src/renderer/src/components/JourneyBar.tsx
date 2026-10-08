import { lessonsOf } from '@shared/profile'
import { useTutor } from '@/agent/tutor'
import { useApp } from '@/state/app'
import { journeySteps, lessonNumber, startLesson, type StepId } from '@/state/journey'

const HINT: Record<StepId, string> = {
  profile: 'Tell the tutor a little about you, then save.',
  test: 'About 10 minutes. Sets your starting level so lessons are pitched right.',
  model: 'Paste an API key for a provider (or run Ollama locally), then pick the tutor model.',
  lesson: 'Everything is ready.'
}

/**
 * Shown on every tab until the first lesson: where you are on the way to it,
 * and one button for the next step. Nothing in the app is a dead end.
 */
export function JourneyBar() {
  const profile = useApp((s) => s.profile)!
  const settings = useApp((s) => s.settings)
  const view = useApp((s) => s.view)
  const { setView, updateProfile } = useApp.getState()
  const inLesson = useTutor((s) => s.history.length > 0)

  if (lessonsOf(profile).length > 0 || inLesson) return null
  const steps = journeySteps(profile, settings)
  const current = steps.find((s) => !s.done) ?? steps[3]
  const here = view === current.view

  const action = () => {
    if (current.id === 'lesson') startLesson()
    else setView(current.view)
  }
  const label: Record<StepId, string> = {
    profile: 'Set up profile',
    test: profile.assessmentDraft ? 'Resume test' : 'Take the test',
    model: 'Connect a model',
    lesson: '▶ Start your first lesson'
  }

  return (
    <div className="journey">
      <span className="journey-title">Get started</span>
      <ol>
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? 'done' : s === current ? 'current' : ''}>
            <button className="link" onClick={() => (s.id === 'lesson' ? setView('studio') : setView(s.view))}>
              <span className="tick">{s.done ? '✓' : i + 1}</span>
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      <span className="spacer" />
      <span className="muted small journey-hint">{current.id === 'lesson' || !here ? HINT[current.id] : 'You are here.'}</span>
      {current.id === 'test' && !profile.assessmentDraft && (
        <button className="link small" onClick={() => updateProfile((p) => ({ ...p, skippedAssessment: true }))} title="The tutor will gauge your level with a few questions instead">
          Skip
        </button>
      )}
      {(!here || current.id === 'lesson') && <button className="primary" onClick={action}>{label[current.id]}</button>}
    </div>
  )
}

/** Top-bar lesson control: start one from anywhere, or get back to the one in progress. */
export function LessonStatus() {
  const profile = useApp((s) => s.profile)!
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const inLesson = useTutor((s) => s.history.length > 0)
  const sessionId = useTutor((s) => s.session?.id)
  const plan = useTutor((s) => s.session?.plan)

  if (!inLesson) {
    // During onboarding the journey bar carries this button.
    if (lessonsOf(profile).length === 0) return null
    return <button className="primary" onClick={() => startLesson()}>▶ Start lesson</button>
  }
  // Where you are, not how long it's taking: lessons end at the goal, not the clock.
  return (
    <span className="lesson-status">
      <span className="live-dot" />
      Lesson {lessonNumber(profile, sessionId)}{plan ? ` · step ${Math.min(plan.step + 1, plan.steps.length)} of ${plan.steps.length}` : ''}
      {view !== 'studio' && <button className="primary" onClick={() => setView('studio')}>Back to lesson</button>}
    </span>
  )
}
