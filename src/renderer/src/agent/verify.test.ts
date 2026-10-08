import { describe, expect, it } from 'vitest'
import { directionErrors, moveClaims } from './verify'

describe('move claims the tutor must verify', () => {
  it('flags statements about direction, chart half or arc', () => {
    // From the learner's real lesson: both were wrong and unverified.
    expect(moveClaims('You are right that it moves toward the top half! The top half is where b is positive.')).toHaveLength(2)
    expect(moveClaims('Exactly. **Shunt C moves the point clockwise** along a constant-g circle.')).toHaveLength(1)
    expect(moveClaims('Trace it around the left side and it crosses the real axis.')).toHaveLength(1)
  })

  it('ignores questions and unrelated text', () => {
    expect(moveClaims('Which way does it move: clockwise or counter-clockwise?')).toHaveLength(0)
    expect(moveClaims('Is the new point in the upper half?\nAdd a 2 pF shunt capacitor and read y.')).toHaveLength(0)
  })
})

describe('wrong directions are caught even after what_if', () => {
  it('the real Gemini slip: "capacitors (both series and shunt) move the point counter-clockwise"', () => {
    const errs = directionErrors('Remember, capacitors (both series and shunt) move the point **counter-clockwise**, while inductors move it **clockwise**. But wait, this is a shunt capacitor, so why did the app say clockwise?')
    expect(errs).toHaveLength(1)
    // Both halves of the false rule are named, with the right facts.
    expect(errs[0].fix).toMatch(/shunt C moves it clockwise/)
    expect(errs[0].fix).toMatch(/shunt L moves it counter-clockwise/)
  })

  it('every element in every common wording, right and wrong', () => {
    expect(directionErrors('A series inductor moves the point clockwise along its constant-r circle.')).toHaveLength(0)
    expect(directionErrors('The shunt C turns it clockwise, and the series C turns it counter-clockwise.')).toHaveLength(0)
    expect(directionErrors('A shunt L moves it anti-clockwise on the g circle.')).toHaveLength(0)
    expect(directionErrors('Adding a shunt capacitor moves the point counter-clockwise.')).toHaveLength(1)
    expect(directionErrors('Series L goes counter-clockwise.')).toHaveLength(1)
    expect(directionErrors('Parallel inductors turn it clockwise.')).toHaveLength(1)
    expect(directionErrors('Moving toward the generator along the line turns it clockwise.')).toHaveLength(0)
    expect(directionErrors('A longer transmission line rotates the point counter-clockwise.')).toHaveLength(1)
    expect(directionErrors('Going back toward the load turns it counter-clockwise.')).toHaveLength(0)
  })

  it('does not flag questions, negations, or the learner\'s own answer being quoted', () => {
    expect(directionErrors('Does a shunt C move it clockwise or counter-clockwise?')).toHaveLength(0)
    expect(directionErrors('A shunt C does not move it counter-clockwise.')).toHaveLength(0)
    expect(directionErrors('You chose counter-clockwise for the shunt C, which is the classic slip.')).toHaveLength(0)
    expect(directionErrors('Your answer said the series L turns counter-clockwise.')).toHaveLength(0)
    expect(directionErrors('The point moves clockwise.')).toHaveLength(0) // no element named: nothing to check
    expect(directionErrors('Both series and shunt elements can match this load.')).toHaveLength(0)
  })
})

describe('isStageDirection', () => {
  it('matches a reply that is only a bracketed aside', async () => {
    const { isStageDirection } = await import('./verify')
    expect(isStageDirection('(The previous message is already on the screen, waiting for your answer!)')).toBe(true)
    expect(isStageDirection("  (I've just posted a quick multiple-choice question on the screen to wrap up that thought!) ")).toBe(true)
    expect(isStageDirection('Nice work (that was the hard one). Now try this.')).toBe(false)
    expect(isStageDirection('(1) Add a shunt C. (2) Add a series L.')).toBe(false)
  })
})
