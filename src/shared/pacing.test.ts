import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, type AnswerRecord, type Profile, type SessionRecord, type SkillId } from './profile'
import { moveOnNote, stuckNote } from './pacing'
import { learnerBrief } from './memory'
import { makeCapstone } from './capstone'
import { moveReading } from './reading'

const T = (d: number) => `2026-10-0${d}T12:00:00.000Z`
const lesson = (id: string, d: number, done = true): SessionRecord =>
  ({ id, startedAt: T(d), endedAt: T(d), transcript: [{ role: 'user', text: 'hi', at: T(d) }], exercises: [], ...(done ? { goalReachedAt: T(d), outcome: 'completed' as const } : {}) })
const answer = (session: string, skill: SkillId, outcome: AnswerRecord['outcome'] = 'correct'): AnswerRecord =>
  ({ at: T(5), session, topic: 'gamma_vswr', skill, difficulty: 1, outcome })
const riya = (sessions: SessionRecord[], answers: AnswerRecord[], x: Partial<Profile> = {}): Profile =>
  ({ ...migrateProfile(createProfile('Riya', { experience: 'new' })), sessions, answers, ...x })

describe('move on: two clean lessons on one skill are enough (the re-run stayed on Γ/VSWR for three)', () => {
  const two = [lesson('L1', 1), lesson('L2', 2)]
  const clean = [answer('L1', 'reflection'), answer('L1', 'reflection'), answer('L2', 'reflection'), answer('L2', 'reflection'), answer('L2', 'chart_basics')]

  it('says so, and where to go: the project\'s next step, or the plan\'s next skill', () => {
    const plan = { nextFocus: { picks: [{ skill: 'reflection' as SkillId, why: 'x' }, { skill: 'admittance' as SkillId, why: 'y' }], at: T(1) } }
    expect(moveOnNote(riya(two, clean, plan))).toBe('Pacing: their last two lessons were both on Γ, VSWR & return loss (reflection), goal reached, no misses. Move on this lesson, to Admittance & Z↔Y (admittance); Γ, VSWR & return loss only as a quick warm-up, if at all.')
    const project = { capstone: makeCapstone({ load: { kind: 'fixed', R: 30, X: -10 }, f0: 2.4e9, maxVswr: 1.5, setBy: 'tutor', at: T(1) }) }
    expect(moveOnNote(riya(two, clean, project))).toMatch(/Move on this lesson, to Chart anatomy & normalization \(chart_basics\)/)
  })

  it('not after a miss, a lesson cut short, two different skills, or a single lesson', () => {
    expect(moveOnNote(riya(two, [...clean, answer('L2', 'reflection', 'incorrect')]))).toBeNull()
    expect(moveOnNote(riya([lesson('L1', 1), lesson('L2', 2, false)], clean))).toBeNull()
    expect(moveOnNote(riya(two, [answer('L1', 'reflection'), answer('L1', 'reflection'), answer('L2', 'admittance'), answer('L2', 'admittance')]))).toBeNull()
    expect(moveOnNote(riya([lesson('L2', 2)], clean))).toBeNull()
  })
})

describe('stuck: "Up next" that nothing has moved for three lessons (the re-run showed one step for ten)', () => {
  const project = { capstone: makeCapstone({ load: { kind: 'fixed', R: 30, X: -10 }, f0: 2.4e9, maxVswr: 1.5, setBy: 'tutor', at: T(1) }) }
  const three = [lesson('L1', 1), lesson('L2', 2), lesson('L3', 3)]

  it('no item on the project\'s next step in the last three lessons since it was set: a nudge', () => {
    const p = riya(three, [answer('L1', 'reflection'), answer('L2', 'admittance'), answer('L3', 'lumped_moves')], project)
    expect(stuckNote(p)).toMatch(/^Stuck: their project's next step \(Chart anatomy & normalization: reading values from the chart yourself\) has had no graded item in their last 3 lessons/)
    expect(learnerBrief(p, T(4)).text).toContain('Stuck: their project\'s next step')
  })

  it('not when one of those lessons worked on it, or fewer than three have passed', () => {
    expect(stuckNote(riya(three, [answer('L2', 'chart_basics')], project))).toBeNull()
    expect(stuckNote(riya(three.slice(0, 2), [], project))).toBeNull()
  })

  it('without a project, the first skill of the plan', () => {
    const plan = { nextFocus: { picks: [{ skill: 'admittance' as SkillId, why: 'x' }], at: T(1) } }
    expect(stuckNote(riya(three, [answer('L3', 'reflection')], plan))).toMatch(/the first skill of your plan \(Admittance & Z↔Y\)/)
    expect(stuckNote(riya(three, [answer('L3', 'admittance')], plan))).toBeNull()
  })
})

describe('right but "not sure" counts half: an always-unsure, always-right learner still moves', () => {
  it('two covered unsure-right readings take them from the readout to the chart, and confirm it there', () => {
    let p = riya([], [])
    const move = (values: 'covered' | 'shown') => {
      const m = moveReading(p, 'chart_basics', values, 'correct', { sure: 'unsure' }, T(5))
      p = { ...p, reading: { ...(p.reading ?? {}), chart_basics: m.state } }
      return m
    }
    p = { ...p, reading: { chart_basics: { stage: 'readout', streak: 0, misses: 0, source: 'answers', at: T(1) } } }
    expect(move('covered').state).toMatchObject({ stage: 'readout', streak: 0.5 })
    expect(move('covered')).toMatchObject({ state: { stage: 'chart' }, note: expect.stringMatching(/twice, unsure but right/) })
    // An estimate at the chart stage (the re-run's chart_basics, provisional for ten lessons) is confirmed by two.
    p = { ...p, reading: { chart_basics: { stage: 'chart', streak: 0, misses: 0, provisional: true, source: 'start', at: T(1) } } }
    expect(move('covered').state).toMatchObject({ provisional: true })
    expect(move('covered').state).toMatchObject({ stage: 'chart', provisional: false, source: 'answers' })
  })

  it('helped or a guess still counts nothing', () => {
    const p = riya([], [], { reading: { chart_basics: { stage: 'readout', streak: 0, misses: 0, source: 'answers', at: T(1) } } })
    expect(moveReading(p, 'chart_basics', 'covered', 'correct', { sure: 'unsure', helped: true }, T(5)).state.streak).toBe(0)
    expect(moveReading(p, 'chart_basics', 'covered', 'correct', { sure: 'guess' }, T(5)).state.streak).toBe(0)
  })
})
