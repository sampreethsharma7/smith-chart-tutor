import { describe, expect, it } from 'vitest'
import { applyEvidence, createProfile, migrateProfile, setMastery, type Profile } from './profile'
import { recordGraded, topicState, learnerBrief, type GradedResult } from './memory'
import { proofFor } from './standing'
import { addSlips, patternsOf, slipsFor } from './patterns'
import { scoreAssessment, QUESTIONS } from './assessment'
import { gradeQuestion, parseNumber } from './rf/tasks'

/** Regressions for what the QA pass found in the learner model. */
const AT = (d: number, h = 0) => new Date(Date.parse('2026-09-01T00:00:00Z') + d * 86400_000 + h * 3600_000).toISOString()
const res = (o: Partial<GradedResult>): GradedResult => ({ meta: { topic: 'plot_z', skill: 'chart_basics', difficulty: 2, ctx: 'a' }, outcome: 'correct', label: 'q', session: 's', at: AT(0), format: 'click', ...o })

describe('learner model regressions', () => {
  it('NaN never gets into mastery, and the brief still renders', () => {
    const s = { mastery: 0.4, confidence: 0.3, evidence: 2, history: [] }
    expect(setMastery(s, NaN, 'x').mastery).toBe(0.4)
    expect(applyEvidence(s, 'great' as never, 2, 'x').mastery).toBe(0.4)
    expect(applyEvidence({ ...s, mastery: NaN }, 'correct', 2, 'x').mastery).toBeNaN() // returned untouched, not spread
    const p = createProfile('A')
    expect(() => learnerBrief(p, AT(0))).not.toThrow()
  })

  it('retaking the placement test leaves skills with graded evidence alone', () => {
    let p = createProfile('A')
    for (let i = 0; i < 12; i++) p = recordGraded(p, res({ session: `L${i % 2}`, at: AT(i), meta: { topic: 'plot_z', skill: 'chart_basics', difficulty: 2, ctx: `c${i % 2}` } })).profile
    const before = p.skills.chart_basics.mastery
    expect(before).toBeGreaterThan(0.7)
    const qs = QUESTIONS.filter((q) => q.skill === 'chart_basics')
    const { skills } = scoreAssessment(qs, qs.map((q) => ({ questionId: q.id, value: null, ms: 1 })), p)
    expect(skills.chart_basics.mastery).toBe(before)
  })

  it('topic "strong" and skill "strong" use the same proof', () => {
    // Two easy right answers in one lesson and two situations: neither strong.
    let p = createProfile('A', { experience: 'intermediate' })
    p = recordGraded(p, res({ meta: { topic: 'plot_z', skill: 'chart_basics', difficulty: 1, ctx: 'a' } })).profile
    p = recordGraded(p, res({ meta: { topic: 'plot_z', skill: 'chart_basics', difficulty: 1, ctx: 'b' }, at: AT(0, 1) })).profile
    expect(topicState(p.topics!.plot_z)).toBe('building')
    expect(proofFor(p, 'chart_basics').strong).toBe(false)
  })

  it('a right answer counted as partial (help, a guess) never lowers the skill', () => {
    const p = createProfile('A')
    const high: Profile = { ...p, skills: { ...p.skills, chart_basics: { mastery: 0.85, confidence: 0.5, evidence: 9, history: [] } } }
    expect(recordGraded(high, res({ helped: true })).profile.skills.chart_basics.mastery).toBeGreaterThanOrEqual(0.85)
    expect(recordGraded(high, res({ sure: 'guess', format: 'mcq', choices: 3 })).profile.skills.chart_basics.mastery).toBeGreaterThanOrEqual(0.85)
  })

  it('right but unsure steps the review back one box, not to the start', () => {
    let p = createProfile('A')
    for (let i = 0; i < 5; i++) p = recordGraded(p, res({ at: AT(i) })).profile
    const box = p.topics!.plot_z!.box
    expect(recordGraded(p, res({ sure: 'unsure', at: AT(9) })).profile.topics!.plot_z!.box).toBe(box - 1)
  })

  it('old topics without newer fields load and record without crashing', () => {
    const p = createProfile('A') as any
    p.topics = { plot_z: { seen: 3, correct: 3, recent: [1, 1, 1], streak: 0, level: 2, box: 2, due: AT(0), lastSeen: AT(0) } }
    const m = migrateProfile(p)
    expect(m.topics!.plot_z!.rightIn).toEqual([])
    expect(() => topicState(m.topics!.plot_z)).not.toThrow()
    expect(() => recordGraded(m, res({}))).not.toThrow()
  })

  it('no false slip at a matched point or on the rim', () => {
    expect(slipsFor({ type: 'value', quantity: 'vswr', expected: 1, tolPct: 5, z0: 50 }, { text: '3' })).toEqual([])
    expect(slipsFor({ type: 'value', quantity: 'gamma_mag', expected: 1, tolPct: 5, z0: 50 }, { text: '7' })).toEqual([])
  })

  it('a decimal comma reads as a decimal, and angles wrap at any size', () => {
    expect(parseNumber('0,35')).toBe(0.35)
    expect(gradeQuestion({ type: 'value', quantity: 'gamma_mag', expected: 0.35, tolPct: 5, z0: 50 }, { text: '0,35' }).status).toBe('correct')
    expect(gradeQuestion({ type: 'value', quantity: 'gamma_angle_deg', expected: 0, tolPct: 5, z0: 50 }, { text: '-720' }).status).toBe('correct')
  })

  it('a pattern does not fade on right answers in the same lesson as the slip', () => {
    let p = createProfile('A')
    p = addSlips(p, [{ confusion: 'z_vs_y', detail: 'd' }], { at: AT(0), session: 'L1', topic: 'plot_y' })
    p = addSlips(p, [{ confusion: 'z_vs_y', detail: 'd' }], { at: AT(1), session: 'L2', topic: 'read_y' })
    p = recordGraded(p, res({ meta: { topic: 'plot_y', skill: 'admittance', difficulty: 2, ctx: 'x' }, session: 'L2', at: AT(1, 2) })).profile
    expect(patternsOf(p)[0].status).toBe('active')
    p = recordGraded(p, res({ meta: { topic: 'plot_y', skill: 'admittance', difficulty: 2, ctx: 'y' }, session: 'L3', at: AT(5) })).profile
    expect(patternsOf(p)[0].status).toBe('fading')
  })

  it('skills missing from an old file start from the learner\'s stated experience', () => {
    const p = createProfile('A', { experience: 'advanced' }) as any
    delete p.skills.stubs
    expect(migrateProfile(p).skills.stubs.mastery).toBe(createProfile('B', { experience: 'advanced' }).skills.stubs.mastery)
  })
})
