import { describe, expect, it } from 'vitest'
import { createProfile, type SessionRecord } from '@shared/profile'
import { buildSystemPrompt, lessonTime } from './prompt'

describe('lesson state in the system prompt', () => {
  const session: SessionRecord = {
    id: 's', startedAt: 'x', transcript: [], exercises: [],
    models: ['Claude Opus 5.5', 'Gemini 3.1 Pro (preview)'],
    plan: { goal: 'Predict series and shunt moves', steps: ['Series', 'Shunt', 'Pick one'], step: 1, coordinates: 'admittance' }
  }
  const { dynamic } = buildSystemPrompt(createProfile('Me'), session)

  it('carries the goal, current step and coordinates', () => {
    expect(dynamic).toMatch(/\[current\] 2\. Shunt/)
    expect(dynamic).toMatch(/Coordinates for the current step: ADMITTANCE/)
  })

  it('states the sign convention explicitly', () => {
    expect(dynamic).toMatch(/upper half b < 0, lower half b > 0/)
  })

  it('tells a model that takes over mid-lesson who taught before it', () => {
    expect(dynamic).toMatch(/Claude Opus 5\.5 → Gemini 3\.1 Pro/)
    expect(dynamic).toMatch(/continuing a lesson another model started/)
  })
})

describe('pace: lesson time and backing off', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 9, 8, 15, 0) + min * 60_000).toISOString()
  const lesson = (msgs: number[]): SessionRecord => ({ id: 's', startedAt: t(0), exercises: [], transcript: msgs.map((m) => ({ role: 'user', text: 'x', at: t(m) })) })

  it('tells the tutor how long the lesson has been going', () => {
    expect(lessonTime(lesson([0, 10, 30]), t(34))).toBe('Lesson time: 34 min.\n')
    expect(lessonTime(null, t(5))).toBe('')
    expect(lessonTime({ ...lesson([]), startedAt: 'x' }, t(5))).toBe('') // a bad date says nothing rather than "NaN"
  })

  it('a lesson picked up again after a break counts this sitting', () => {
    expect(lessonTime(lesson([0, 20, 60 * 24, 60 * 24 + 5]), t(60 * 24 + 12))).toBe('Lesson time: 12 min (this sitting; resumed after a break).\n')
  })

  it('is in the prompt, with the instruction to back off on short or frustrated replies', () => {
    const s = lesson([0])
    expect(buildSystemPrompt(createProfile('Me'), s).dynamic).toMatch(/## This lesson[^\n]*\nLesson time: \d+ min\./)
    expect(buildSystemPrompt(createProfile('Me'), s).stable).toMatch(/If replies turn short or flat .* back off/)
    expect(buildSystemPrompt(createProfile('Me'), s).stable).toMatch(/past about 45 minutes \(see Lesson time\), offer to wrap up/)
  })
})
