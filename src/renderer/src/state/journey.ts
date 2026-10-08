import { lessonsOf, type LessonFocus, type Profile } from '@shared/profile'
import type { AppSettings } from '@shared/ipc'
import { useTutor } from '@/agent/tutor'
import { activeProvider, useApp, type View } from './app'

/**
 * Everything in the app leads to one place: a lesson with the tutor.
 * This module knows the steps to get there and starts lessons from any tab.
 */

const isLocal = (url?: string) => /localhost|127\.0\.0\.1/.test(url ?? '')

export function modelReady(): boolean {
  const p = activeProvider()
  return !!p && (!!p.hasKey || isLocal(p.baseUrl))
}

export type StepId = 'profile' | 'test' | 'model' | 'lesson'

export interface Step {
  id: StepId
  label: string
  done: boolean
  view: View
}

export function journeySteps(profile: Profile, settings: AppSettings): Step[] {
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const ready = !!provider && (!!provider.hasKey || isLocal(provider.baseUrl))
  return [
    { id: 'profile', label: 'Your profile', done: profile.setupComplete, view: 'profiles' },
    { id: 'test', label: 'Placement test', done: !!profile.assessment || !!profile.skippedAssessment || lessonsOf(profile).length > 0, view: 'assessment' },
    { id: 'model', label: 'Tutor model', done: ready, view: 'models' },
    { id: 'lesson', label: 'First lesson', done: lessonsOf(profile).length > 0, view: 'studio' }
  ]
}

/** Lessons finished or in progress before the current one, plus one. */
export function lessonNumber(profile: Profile, currentSessionId?: string): number {
  return lessonsOf(profile).filter((s) => s.id !== currentSessionId).length + 1
}

export function lessonActive(): boolean {
  return useTutor.getState().history.length > 0
}

/**
 * Start a lesson from anywhere. Without a usable model, goes to Models instead
 * (the journey bar then shows "Start lesson" as soon as one is connected).
 */
export async function startLesson(focus?: LessonFocus) {
  const app = useApp.getState()
  if (!modelReady()) {
    app.setView('models')
    return
  }
  await app.setView('studio')
  if (useApp.getState().view !== 'studio') return // an assistant is mid-reply on the other chart
  const t = useTutor.getState()
  if (t.busy) return
  if (t.history.length) {
    if (!focus) return // a lesson is already running: just go back to it
    if (!window.confirm('End the current lesson (it will be summarised and saved) and start a new one?')) return
    await t.endSession()
  }
  await useTutor.getState().startSession(focus)
}
