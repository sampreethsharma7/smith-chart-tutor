import { describe, expect, it } from 'vitest'
import { c, inv, conj } from './rf/complex'
import { gammaFromZ } from './rf/metrics'
import { moveQuestion, type QuestionKey } from './rf/tasks'
import { createProfile, type Profile } from './profile'
import { recordGraded, type TopicId } from './memory'
import { addSlips, MISTAKE_CONFUSION, patternNews, patternsBrief, patternsOf, slipsFor, type Confusion } from './patterns'

const F = 2.4e9
const Z0 = 50
const kinds = (xs: Array<{ confusion: Confusion }>) => xs.map((x) => x.confusion)

describe('telling exactly how an answer is wrong', () => {
  const moveKey = (kind: 'seriesL' | 'shuntC' | 'tline') => {
    const q = moveQuestion(c(30, 20), { id: 'x', kind, value: kind === 'tline' ? 30 : kind === 'seriesL' ? 3e-9 : 2e-12, zc: Z0, refHz: F }, F, Z0)
    return { key: { type: 'move', choices: q.choices, correct: q.correct, facts: q.facts, reasons: q.reasons } as Extract<QuestionKey, { type: 'move' }>, q }
  }

  it('move questions: the wrong circle, the wrong way, or both', () => {
    const { key } = moveKey('seriesL') // right: clockwise along constant-r (index 0)
    expect(key.correct).toBe(0)
    const why = key.reasons!.choices[key.reasons!.correct]
    expect(kinds(slipsFor(key, { choice: key.choices[1], reason: why }))).toEqual(['rotation_sense'])
    expect(kinds(slipsFor(key, { choice: key.choices[2], reason: why }))).toEqual(['series_vs_shunt'])
    expect(kinds(slipsFor(key, { choice: key.choices[3], reason: why }))).toEqual(['series_vs_shunt', 'rotation_sense'])
    expect(slipsFor(key, { choice: key.choices[0], reason: why })).toEqual([])
  })

  it('the reason shows the idea even when the direction was right', () => {
    const { key } = moveKey('seriesL')
    const pick = (id: string) => key.reasons!.choices[key.reasons!.ids!.indexOf(id)]
    expect(kinds(slipsFor(key, { choice: key.choices[0], reason: pick('sx_down') }))).toEqual(['reactance_sign'])
    expect(kinds(slipsFor(key, { choice: key.choices[0], reason: pick('pb_up') }))).toEqual(['series_vs_shunt'])
    expect(kinds(slipsFor(key, { choice: key.choices[0], reason: pick('pb_down') }))).toEqual(['series_vs_shunt', 'reactance_sign'])
  })

  it('lines: moving it like a lumped part, or the wrong way round', () => {
    const { key } = moveKey('tline')
    expect(kinds(slipsFor(key, { choice: key.choices[2] }))).toEqual(['line_motion'])
    expect(kinds(slipsFor(key, { choice: key.choices[1 - key.correct] }))).toEqual(['line_direction'])
  })

  it('clicks: the admittance point, the other half, r and x swapped; a near miss is just imprecise', () => {
    const z = c(0.5, 1.5)
    const key = { type: 'locate' as const, target: gammaFromZ(z, 1), tol: 0.06, targetText: 'z' }
    expect(kinds(slipsFor(key, { gamma: gammaFromZ(inv(z), 1) }))).toEqual(['z_vs_y'])
    expect(kinds(slipsFor(key, { gamma: gammaFromZ(conj(z), 1) }))).toEqual(['reactance_sign'])
    expect(kinds(slipsFor(key, { gamma: gammaFromZ(c(1.5, 0.5), 1) }))).toEqual(['r_x_swap'])
    const near = gammaFromZ(z, 1)
    expect(slipsFor(key, { gamma: c(near.re + 0.08, near.im) })).toEqual([])
  })

  it('values: |Γ| for VSWR, radians, y for z, forgetting to normalise, the sign of return loss, WTL for WTG', () => {
    const v = (quantity: string, expected: number | ReturnType<typeof c>, text: string) =>
      kinds(slipsFor({ type: 'value', quantity: quantity as never, expected, tolPct: 5, z0: Z0 }, { text }))
    expect(v('vswr', 2, '0.333')).toEqual(['gamma_vs_vswr'])
    expect(v('vswr', 2, '9.54')).toEqual(['gamma_vs_vswr'])
    expect(v('gamma_mag', 1 / 3, '2')).toEqual(['gamma_vs_vswr'])
    expect(v('return_loss_db', 9.54, '-9.5')).toEqual(['gamma_vs_vswr'])
    expect(v('gamma_angle_deg', 121, '2.11')).toEqual(['angle_units'])
    expect(v('gamma_angle_deg', 121, '-121')).toEqual(['reactance_sign'])
    expect(v('z', c(0.6, 0.4), '1.15 - j0.77')).toEqual(['z_vs_y'])
    expect(v('z', c(0.6, 0.4), '0.6 - j0.4')).toEqual(['reactance_sign'])
    expect(v('z', c(0.6, 0.4), '30 + j20')).toEqual(['normalisation'])
    expect(v('Z_ohm', c(30, 20), '0.6 + j0.4')).toEqual(['normalisation'])
    expect(v('wtg_lambda', 0.08, '0.42')).toEqual(['line_direction'])
    // Just wrong, in no recognisable way: nothing is guessed.
    expect(v('vswr', 2, '3.7')).toEqual([])
    expect(v('z', c(0.6, 0.4), '2 + j3')).toEqual([])
  })

  it('spot the mistake: accepting a planted mistake shows its confusion; there is none to miss when nothing was planted', () => {
    const key = { type: 'pick' as const, choices: ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'No mistake'], correct: 3, facts: '', missed: MISTAKE_CONFUSION.formula }
    expect(kinds(slipsFor(key, { choice: 'No mistake' }))).toEqual(['two_pi'])
    expect(slipsFor({ ...key, correct: 4, missed: MISTAKE_CONFUSION.none }, { choice: 'Step 2' })).toEqual([])
  })
})

describe('patterns: a confusion that keeps coming back', () => {
  const slip = (p: Profile, confusion: Confusion, topic: TopicId, session: string, at: string) =>
    addSlips(p, [{ confusion, detail: 'd' }], { at, session, topic })
  const rightIn = (p: Profile, topic: TopicId, session: string, at: string) =>
    recordGraded(p, { meta: { topic, skill: 'admittance', difficulty: 2, ctx: session }, outcome: 'correct', label: 'q', session, at, format: 'click' }).profile

  it('once is a slip; twice in one topic and one lesson is still a slip; two topics or two lessons is a pattern', () => {
    let p = createProfile('A')
    p = slip(p, 'z_vs_y', 'plot_y', 'L1', '2026-09-01T00:00:00Z')
    expect(patternsOf(p)).toEqual([])
    p = slip(p, 'z_vs_y', 'plot_y', 'L1', '2026-09-01T00:10:00Z')
    expect(patternsOf(p)).toEqual([])
    const twoTopics = slip(p, 'z_vs_y', 'dir_shuntC', 'L1', '2026-09-01T00:20:00Z')
    expect(patternsOf(twoTopics)[0]).toMatchObject({ confusion: 'z_vs_y', status: 'active', topics: ['plot_y', 'dir_shuntC'], lessons: 1 })
    const twoLessons = slip(p, 'z_vs_y', 'plot_y', 'L2', '2026-09-08T00:00:00Z')
    expect(patternsOf(twoLessons)[0]).toMatchObject({ status: 'active', lessons: 2 })
  })

  it('looks better with clean answers in later lessons, clears at its bar, is confirmed by one more, and comes back as a relapse with a higher bar', () => {
    let p = createProfile('A')
    p = slip(p, 'z_vs_y', 'plot_y', 'L1', '2026-09-01T00:00:00Z')
    p = slip(p, 'z_vs_y', 'read_y', 'L2', '2026-09-08T00:00:00Z')
    // Right answers BEFORE it was last seen don't count.
    p = rightIn(p, 'plot_y', 'L1', '2026-09-01T00:30:00Z')
    expect(patternsOf(p)[0]).toMatchObject({ status: 'active', signoff: { points: 0, required: 2 } })
    p = rightIn(p, 'plot_y', 'L3', '2026-09-15T00:00:00Z')
    expect(patternsOf(p)[0]).toMatchObject({ status: 'improving', signoff: { points: 1 } })
    p = rightIn(p, 'read_y', 'L4', '2026-09-22T00:00:00Z')
    expect(patternsOf(p)[0].status).toBe('cleared')
    p = rightIn(p, 'plot_y', 'L5', '2026-09-26T00:00:00Z')
    expect(patternsOf(p)[0].status).toBe('confirmed')
    const back = slip(p, 'z_vs_y', 'dir_shuntL', 'L6', '2026-09-29T00:00:00Z')
    expect(patternsOf(back)[0]).toMatchObject({ status: 'active', relapses: 1 })
    expect(patternsOf(back)[0].signoff.required).toBeGreaterThan(2)
    expect(patternNews(p, back)[0]).toMatch(/^PATTERN BACK: Mixes up impedance and admittance/)
  })

  it('the tutor hears about a new pattern once, and sees live ones in its brief with how to check them', () => {
    let p = createProfile('A')
    p = slip(p, 'two_pi', 'l_match', 'L1', '2026-09-01T00:00:00Z')
    const q = slip(p, 'two_pi', 'l_match_tight', 'L2', '2026-09-08T00:00:00Z')
    expect(patternNews(p, q)).toEqual([expect.stringMatching(/^NEW PATTERN: Forgets the 2π .* seen 2× in 2 topic\(s\) over 2 lesson\(s\)/)])
    const r = slip(q, 'two_pi', 'l_match', 'L3', '2026-09-15T00:00:00Z')
    expect(patternNews(q, r)).toEqual([])
    expect(patternsBrief(r)).toMatch(/^Patterns .*two_pi \[still there, 0\/2\.5\] Forgets the 2π.*seen 3×.*Check it with: ask_component for a series and a shunt part, then ask_spot_error with mistake "formula"/)
  })

  it('the record is bounded', () => {
    let p = createProfile('A')
    for (let i = 0; i < 200; i++) p = slip(p, 'rotation_sense', 'dir_seriesL', `L${i}`, new Date(Date.parse('2026-01-01') + i * 3600_000).toISOString())
    expect(p.slips).toHaveLength(150)
  })
})
