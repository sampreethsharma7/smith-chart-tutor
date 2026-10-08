import { describe, expect, it } from 'vitest'
import { applyEvidence, createProfile, JUDGEMENT_CAP, migrateProfile, SCORING, setMastery, type Profile } from './profile'
import { evidenceWeight, recordGraded, type GradedResult } from './memory'
import { QUESTIONS, scoreAssessment } from './assessment'

const AT = '2026-10-07T12:00:00.000Z'
const result = (o: Partial<GradedResult> = {}): GradedResult => ({
  meta: { topic: 'dir_shuntL', skill: 'lumped_moves', difficulty: 2 }, outcome: 'correct', label: 'q', session: 's', at: AT, ...o
})

describe('an answer counts for what it proves', () => {
  it('a right pick from choices is discounted by the chance of guessing it; clicks, values, tasks and wrong answers count fully', () => {
    expect(evidenceWeight('mcq', 3, 'correct')).toBeCloseTo(2 / 3)
    expect(evidenceWeight('mcq', 4, 'correct')).toBeCloseTo(3 / 4)
    expect(evidenceWeight('mcq', 3, 'incorrect')).toBe(1)
    for (const f of ['click', 'value', 'task'] as const) expect(evidenceWeight(f, undefined, 'correct')).toBe(1)
    const p = createProfile('A')
    const pick = recordGraded(p, result({ format: 'mcq', choices: 3 }))
    const click = recordGraded(p, result({ format: 'click' }))
    expect(pick.profile.skills.lumped_moves.mastery).toBeLessThan(click.profile.skills.lumped_moves.mastery)
    expect(pick.profile.skills.lumped_moves.confidence).toBeLessThan(click.profile.skills.lumped_moves.confidence)
    expect(pick.report).toMatch(/a pick from 3 choices, so it counts 67% \(could be a guess\)/)
  })

  it('right with help is partly right: less mastery, no level-up streak, and no proof of strength', () => {
    const p = createProfile('A')
    const helped = recordGraded(p, result({ format: 'task', helped: true }))
    const alone = recordGraded(p, result({ format: 'task' }))
    expect(helped.profile.skills.lumped_moves.mastery).toBeLessThan(alone.profile.skills.lumped_moves.mastery)
    expect(helped.profile.topics!.dir_shuntL!.rightIn).toHaveLength(0)
    expect(alone.profile.topics!.dir_shuntL!.rightIn).toEqual([{ session: 's', at: AT, d: 2 }])
    expect(helped.report).toMatch(/counted as partly right: they had help/)
  })
})

describe('judgement alone never makes a skill strong', () => {
  it('the placement test sets a start, at most JUDGEMENT_CAP, even with every answer right', () => {
    const p = createProfile('A', { experience: 'advanced' })
    const qs = QUESTIONS.filter((q) => q.skill === 'chart_basics')
    const answers = qs.map((q) => ({ questionId: q.id, value: q.kind === 'mcq' ? q.answer : q.kind === 'numeric' ? q.answer : q.target, ms: 1000 }))
    const { skills } = scoreAssessment(qs, answers as any, p)
    expect(skills.chart_basics.mastery).toBe(JUDGEMENT_CAP)
  })

  it('the tutor\'s override can lower freely but raise only to JUDGEMENT_CAP', () => {
    const s = { mastery: 0.3, confidence: 0.5, evidence: 4, history: [] }
    expect(setMastery(s, 0.95, 'r').mastery).toBe(JUDGEMENT_CAP)
    expect(setMastery(s, 0.1, 'r').mastery).toBe(0.1)
    // Already above the cap from graded work: an override can't push it higher, nor does it drop it.
    expect(setMastery({ ...s, mastery: 0.8 }, 0.95, 'r').mastery).toBe(0.8)
  })

  it('evidence with a cap stops there (the tutor\'s record_evidence), without ever lowering a higher skill', () => {
    let s = { mastery: 0.3, confidence: 0, evidence: 0, history: [] as any[] }
    for (let i = 0; i < 40; i++) s = applyEvidence(s, 'correct', 3, 't', { weight: 0.5, cap: JUDGEMENT_CAP })
    expect(s.mastery).toBeCloseTo(JUDGEMENT_CAP, 9)
    expect(applyEvidence({ ...s, mastery: 0.9 }, 'correct', 3, 't', { cap: JUDGEMENT_CAP }).mastery).toBe(0.9)
  })

  it('old profiles: a skill with no graded answers behind it comes down to the cap, once; graded skills keep their number', () => {
    const old = createProfile('Sam') as Profile
    delete (old as Partial<Profile>).scoring
    old.skills.chart_basics = { mastery: 0.82, confidence: 0.35, evidence: 3, history: [{ at: AT, mastery: 0.82, source: 'placement test' }] }
    old.skills.reflection = { mastery: 0.8, confidence: 0.7, evidence: 9, history: [{ at: AT, mastery: 0.8, source: 'app: VSWR read' }] }
    const m = migrateProfile(old)
    expect(m.scoring).toBe(SCORING)
    expect(m.skills.chart_basics.mastery).toBe(JUDGEMENT_CAP)
    expect(m.skills.chart_basics.history.at(-1)!.source).toBe('rescored: no graded answers yet')
    expect(m.skills.reflection.mastery).toBe(0.8)
    // Once only: a later number above the cap (e.g. from graded work) is left alone.
    const again = migrateProfile({ ...m, skills: { ...m.skills, chart_basics: { ...m.skills.chart_basics, mastery: 0.9 } } })
    expect(again.skills.chart_basics.mastery).toBe(0.9)
  })
})
