import { describe, expect, it } from 'vitest'
import { inferFromStepText, migrateLessonState } from './lesson'
import type { SessionRecord } from './profile'

const legacy = (steps: string[], step: number, tutorSays: string[]): SessionRecord => ({
  id: 's', startedAt: 'x', exercises: [],
  // Saved before coordinates were recorded: no `coordinates` on the plan.
  plan: { goal: 'Predict and verify which way a series or shunt L or C moves a point', steps, step },
  transcript: tutorSays.map((text) => ({ role: 'tutor' as const, text, at: 'x' }))
})

describe('legacy lesson migration (coordinates)', () => {
  it('REGRESSION: shunt-C step + "y = 1.15 − j0.77" resolves to admittance, never impedance', () => {
    const s = legacy(
      ['Series L and series C: moving along constant-r circles', 'Shunt L and shunt C: moving along constant-g circles', 'Choose one element'],
      1,
      ['The same load point, now written as y = 1.15 − j0.77, is marked, along with its g = 1.15 circle. Think about what adding +jωC does to y.']
    )
    const m = migrateLessonState(s)
    expect(m.plan?.coordinates).toBe('admittance')
    expect(m.plan?.coordinates).not.toBe('impedance')
    expect(m.plan?.coordinatesInferred).toBe(true)
  })

  it('still resolves to admittance when the tutor\'s latest messages also mention z (the learner\'s real lesson)', () => {
    const s = legacy(
      ['Series L and series C: moving along constant-r circles', 'Shunt L and shunt C: moving along constant-g circles', 'Choose one element'],
      1,
      [
        'Spot on. A shunt element keeps g constant and changes b. Shunt moves follow the red constant-g circles.',
        'Add a shunt C of 2 pF. Its admittance is about +j1.5, so from y = 1.15 − j0.77 you cross the axis.',
        'You are looking at the z coordinates. Your new point is z ≈ 0.61 − j0.39. But we were tracking the admittance (y).',
        'The end point admittance is y = 1.15 + j0.74.'
      ]
    )
    expect(migrateLessonState(s).plan?.coordinates).toBe('admittance')
  })

  it('a series step with z talk resolves to impedance', () => {
    const s = legacy(['Series L and series C: moving along constant-r circles', 'Shunt'], 0, ['Your load z = 0.6 + j0.4 sits on the r = 0.6 circle.'])
    expect(migrateLessonState(s).plan?.coordinates).toBe('impedance')
  })

  it('ambiguous evidence gives "unknown", not a default', () => {
    const s = legacy(['Choose one element that moves a given point onto a target circle'], 0, ['Nice work so far.'])
    expect(migrateLessonState(s).plan?.coordinates).toBe('unknown')
  })

  it('leaves lessons that already recorded coordinates alone', () => {
    const s = legacy(['Shunt moves along constant-g'], 0, [])
    s.plan!.coordinates = 'impedance'
    expect(migrateLessonState(s)).toBe(s)
  })

  it('infers a new step\'s coordinates from its wording, or says unknown', () => {
    expect(inferFromStepText('Shunt L and shunt C: moving along constant-g circles')).toBe('admittance')
    expect(inferFromStepText('Series L and series C: moving along constant-r circles')).toBe('impedance')
    expect(inferFromStepText('Choose one element that moves a given point onto a target circle')).toBe('unknown')
  })
})
