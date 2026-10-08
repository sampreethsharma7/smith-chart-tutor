import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, type Misconception, type Profile } from './profile'
import type { TopicStat } from './memory'
import { gatherEvidence, lessonStrength, requiredFor, signOff, trackOf, type Evidence } from './signoff'

const AT = (d: number) => new Date(Date.UTC(2026, 8, 1) + d * 86_400_000).toISOString()
const base = () => migrateProfile(createProfile('Sam'))

/** A learner with a history: graded answers, how sure they were, and mistakes cleared (some coming back). */
function withHistory(o: { seen: number; correct: number; sure?: [number, number]; cleared?: number; relapses?: number }): Profile {
  const p = base()
  const stat = (seen: number, correct: number): TopicStat => ({ seen, correct, recent: [], streak: 0, level: 2, box: 2, due: AT(0), lastSeen: AT(0), rightIn: [] })
  const [sureN, sureRight] = o.sure ?? [0, 0]
  const ms: Misconception[] = Array.from({ length: o.cleared ?? 0 }, (_, i) => ({
    id: `m${i}`, skill: 'lumped_moves', description: `old ${i}`, count: 1, firstSeen: AT(0), lastSeen: AT(0), resolved: true,
    relapses: i < (o.relapses ?? 0) ? 1 : 0
  }))
  return {
    ...p,
    topics: { plot_z: stat(o.seen, o.correct) },
    calibration: Array.from({ length: sureN }, (_, i) => ({ sure: 'sure' as const, right: i < sureRight, at: AT(0) })),
    misconceptions: ms
  }
}

const lesson = (session: string, d: number, e: Partial<Evidence> = {}): Evidence => ({ session, at: AT(d), kind: 'graded', ...e })
const slip = { count: 1, lessons: 1, relapses: 0 }

describe('the bar comes from the learner\'s own record', () => {
  it('a new learner, or one with little history, gets the standard bar (two lessons), however their few answers went', () => {
    expect(trackOf(base())).toMatchObject({ factor: 0, why: 'not much history yet, so the standard bar' })
    // Three answers, all wrong, and sure of one: not enough to judge them by.
    const shaky = withHistory({ seen: 3, correct: 0, sure: [1, 0] })
    expect(trackOf(shaky).factor).toBe(0)
    expect(requiredFor(trackOf(shaky), 0)).toBe(2)
  })

  it('a learner who picks things up quickly and keeps them gets a lower bar: one strong lesson', () => {
    const quick = withHistory({ seen: 80, correct: 76, sure: [20, 20], cleared: 8 })
    const t = trackOf(quick)
    expect(t.factor).toBeGreaterThan(0.5)
    expect(t.why).toMatch(/lower bar.*you usually keep what you learn.*you pick things up quickly/)
    const req = requiredFor(t, 0)
    expect(req).toBe(1.25)
    // One plain right answer in a later lesson: looking better. One sure right answer: cleared.
    expect(signOff([lesson('L2', 1)], t, slip).status).toBe('improving')
    expect(signOff([lesson('L2', 1, { sure: true })], t, slip).status).toBe('cleared')
  })

  it('a learner whose fixes have come back gets a higher bar: two plain lessons are not enough', () => {
    const slips = withHistory({ seen: 60, correct: 30, sure: [10, 5], cleared: 6, relapses: 5 })
    const t = trackOf(slips)
    expect(t.factor).toBeLessThan(-0.3)
    expect(t.why).toMatch(/higher bar.*some of your fixes have come back before/)
    expect(requiredFor(t, 0)).toBeGreaterThan(2)
    expect(signOff([lesson('L2', 1), lesson('L3', 2)], t, slip).status).toBe('improving')
    expect(signOff([lesson('L2', 1), lesson('L3', 2), lesson('L4', 3)], t, slip).status).toBe('cleared')
  })

  it('history counts more as it grows: the same rates move the bar further with more behind them', () => {
    const few = trackOf(withHistory({ seen: 10, correct: 10, sure: [3, 3], cleared: 1 }))
    const many = trackOf(withHistory({ seen: 100, correct: 100, sure: [30, 30], cleared: 10 }))
    expect(many.factor).toBeGreaterThan(few.factor)
  })
})

describe('how deep the mistake is', () => {
  const t = trackOf(base())

  it('sure of it, or seen again and again, or back after being cleared: a higher bar', () => {
    expect(signOff([], t, slip).required).toBe(2)
    expect(signOff([], t, { ...slip, confident: true }).required).toBe(2.25)
    expect(signOff([], t, { count: 3, lessons: 2, relapses: 0 }).required).toBe(2.5)
    expect(signOff([], t, { count: 2, lessons: 2, relapses: 1 }).required).toBe(2.5)
  })

  it('a deep mistake also needs one lesson where they did it in a new situation', () => {
    const deep = { count: 6, lessons: 4, relapses: 0 }
    const plain = [lesson('L5', 5, { sure: true }), lesson('L6', 6, { sure: true }), lesson('L7', 7, { sure: true })]
    const so = signOff(plain, t, deep)
    expect(so.points).toBeGreaterThanOrEqual(so.required)
    expect(so.status).toBe('improving')
    expect(so.needed).toMatch(/including one in a new situation/)
    expect(signOff([...plain.slice(0, 2), lesson('L7', 7, { transfer: true })], t, deep).status).toBe('cleared')
  })
})

describe('the evidence', () => {
  it('a lesson counts once, at most 1.5: right is 1, and being sure, the reason and transfer add a quarter each', () => {
    expect(lessonStrength([lesson('L', 0)])).toBe(1)
    expect(lessonStrength([lesson('L', 0, { sure: true })])).toBe(1.25)
    expect(lessonStrength([lesson('L', 0, { sure: true }), { session: 'L', at: AT(0), kind: 'tutor', reason: true, transfer: true }])).toBe(1.5)
    // Ten right answers in one lesson are still one lesson.
    expect(signOff(Array.from({ length: 10 }, () => lesson('L2', 1, { sure: true })), trackOf(base()), slip).points).toBe(1.25)
  })

  it('the tutor\'s judgement alone counts half, more with the reason and transfer; partly right counts a quarter', () => {
    expect(lessonStrength([{ session: 'L', at: AT(0), kind: 'tutor' }])).toBe(0.5)
    expect(lessonStrength([{ session: 'L', at: AT(0), kind: 'tutor', reason: true, transfer: true }])).toBe(1)
    expect(lessonStrength([{ session: 'L', at: AT(0), kind: 'tutor', partial: true }])).toBe(0.25)
  })

  it('never from the lesson it appeared in, nor from before it was last seen', () => {
    const p = base()
    const stat: TopicStat = {
      seen: 4, correct: 3, recent: [], streak: 0, level: 1, box: 1, due: AT(0), lastSeen: AT(3),
      rightIn: [{ session: 'L0', at: AT(0) }, { session: 'L1', at: AT(1) }, { session: 'L2', at: AT(2) }, { session: 'L3', at: AT(3), ctx: 'lower half' }]
    }
    const q: Profile = { ...p, topics: { dir_shuntC: stat } }
    const ev = gatherEvidence(q, { topics: ['dir_shuntC'], after: AT(1), exclude: new Set(['L1']), seenCtx: new Set(['upper half']) })
    expect(ev.map((e) => e.session)).toEqual(['L2', 'L3'])
    expect(ev.find((e) => e.session === 'L3')!.transfer).toBe(true) // a different situation from where it was seen
    expect(ev.find((e) => e.session === 'L2')!.transfer).toBe(false) // no situation recorded: not counted as transfer
  })

  it('cleared is provisional: a clean lesson after the one that cleared it confirms it', () => {
    const t = trackOf(base())
    const two = [lesson('L2', 1), lesson('L3', 2)]
    expect(signOff(two, t, slip)).toMatchObject({ status: 'cleared', clearedIn: 'L3', needed: 'one clean answer in a later lesson to confirm it' })
    expect(signOff([...two, lesson('L4', 3)], t, slip).status).toBe('confirmed')
  })
})
