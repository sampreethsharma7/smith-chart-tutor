import { describe, expect, it } from 'vitest'
import { createProfile, type SessionRecord } from '@shared/profile'
import { buildSystemPrompt } from './prompt'

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
