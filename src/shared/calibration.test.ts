import { describe, expect, it } from 'vitest'
import { createProfile, type Profile, type Sure } from './profile'
import { calibrationOf, learnerBrief, recordGraded, type GradedResult } from './memory'

const AT = '2026-10-07T12:00:00.000Z'
const result = (o: Partial<GradedResult> = {}): GradedResult => ({
  meta: { topic: 'dir_shuntL', skill: 'lumped_moves', difficulty: 2, ctx: 'upper' }, outcome: 'correct', label: 'q', session: 's', at: AT, format: 'click', ...o
})
const mastery = (p: Profile) => p.skills.lumped_moves.mastery

describe('how sure they were changes what an answer proves', () => {
  it('right and sure counts fully and is proof; right but unsure counts less, is no proof and comes back soon; a right guess is partly right', () => {
    const p = createProfile('A')
    const sure = recordGraded(p, result({ sure: 'sure' })).profile
    const unsure = recordGraded(p, result({ sure: 'unsure' }))
    const guess = recordGraded(p, result({ sure: 'guess' }))
    expect(mastery(sure)).toBeGreaterThan(mastery(unsure.profile))
    expect(mastery(unsure.profile)).toBeGreaterThan(mastery(guess.profile))
    expect(sure.topics!.dir_shuntL!.rightIn).toHaveLength(1)
    expect(unsure.profile.topics!.dir_shuntL!.rightIn).toHaveLength(0)
    expect(guess.profile.topics!.dir_shuntL!.rightIn).toHaveLength(0)
    // Review: sure moves on (box 1 → in a day), unsure stays in the first box (today).
    expect(sure.topics!.dir_shuntL!.box).toBe(1)
    expect(unsure.profile.topics!.dir_shuntL!.box).toBe(0)
    expect(unsure.report).toMatch(/weren't sure: it comes back for review soon/)
    expect(guess.report).toMatch(/guessing: counted as partly right/)
  })

  it('wrong and sure is a real misconception, flagged and put first; a wrong guess is a gap, not a misconception', () => {
    const p = createProfile('A')
    const sure = recordGraded(p, result({ outcome: 'incorrect', sure: 'sure' }))
    expect(sure.profile.misconceptions).toHaveLength(1)
    expect(sure.profile.misconceptions[0]).toMatchObject({ confident: true, description: 'Sure of a wrong answer on which way a shunt L moves the point' })
    expect(sure.report).toMatch(/they were SURE of this wrong answer/)
    const guess = recordGraded(p, result({ outcome: 'incorrect', sure: 'guess', misconception: 'Thinks a shunt L moves clockwise' }))
    expect(guess.profile.misconceptions).toHaveLength(0)
    // Unsure and wrong with a specific wrong idea: recorded, not flagged.
    const unsure = recordGraded(p, result({ outcome: 'incorrect', sure: 'unsure', misconception: 'Thinks a shunt L moves clockwise' }))
    expect(unsure.profile.misconceptions[0].confident).toBeUndefined()
    // In the brief, the one they were sure of comes first and says so.
    const both = recordGraded(recordGraded(p, result({ outcome: 'incorrect', sure: 'unsure', misconception: 'Mixes up r and x', meta: { topic: 'read_z', skill: 'chart_basics', difficulty: 1 } })).profile, result({ outcome: 'incorrect', sure: 'sure', at: '2026-10-01T00:00:00.000Z' })).profile
    // ...with where it stands against its bar (sure of it: a higher bar than a slip, 2.25 vs 2).
    expect(learnerBrief(both, AT).text).toMatch(/Live misconceptions: \[[^\]]+\] Sure of a wrong answer on which way a shunt L moves the point \([^)]*they were sure: undo this first\) still there, 0\/2\.25; \[[^\]]+\] Mixes up r and x \(read_z, 1×\) still there, 0\/2$/m)
  })
})

describe('calibration: does their feeling match their results?', () => {
  const answers = (p: Profile, list: Array<[Sure, boolean]>) =>
    list.reduce((q, [sure, ok], i) => recordGraded(q, result({ sure, outcome: ok ? 'correct' : 'incorrect', at: `2026-10-0${1 + (i % 7)}T0${i % 10}:00:00.000Z` })).profile, p)

  it('needs a few answers before it says anything', () => {
    expect(calibrationOf(answers(createProfile('A'), [['sure', true], ['unsure', true]])).verdict).toBe('unknown')
  })

  it('right most of the time while unsure: underconfident (the imposter case), and the tutor is told to say so with numbers', () => {
    const p = answers(createProfile('A'), [['unsure', true], ['unsure', true], ['unsure', true], ['guess', true], ['unsure', false], ['sure', true]])
    const c = calibrationOf(p)
    expect(c.verdict).toBe('under')
    expect(c.unsure).toEqual({ n: 4, right: 3 })
    expect(learnerBrief(p, AT).text).toMatch(/Self-judgement: when sure 100% right \(1\), unsure 75% right \(4\), guessing 100% right \(1\): underconfident/)
  })

  it('often wrong while sure: overconfident', () => {
    const p = answers(createProfile('A'), [['sure', false], ['sure', true], ['sure', false], ['sure', false], ['unsure', false]])
    expect(calibrationOf(p).verdict).toBe('over')
  })

  it('feeling matches results: fair', () => {
    const p = answers(createProfile('A'), [['sure', true], ['sure', true], ['sure', true], ['unsure', false], ['guess', false], ['unsure', true]])
    expect(calibrationOf(p).verdict).toBe('fair')
  })
})
