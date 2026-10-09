import { describe, expect, it } from 'vitest'
import { applyEvidence, createProfile, type Profile, type SkillId } from './profile'
import { recordGraded, TOPICS, type TopicId } from './memory'
import { BENCHMARKS, candidates, overall, PROOF, skillStanding, standingForTutor, topicStanding } from './standing'

const NOW = '2026-10-07T12:00:00.000Z'

/**
 * `n` graded answers on a skill, the honest way (recordGraded): spread over `lessons`
 * lessons and `contexts` situations, clicks unless said otherwise.
 */
function graded(p: Profile, skill: SkillId, n: number, difficulty: 1 | 2 | 3, o: { right?: boolean; lessons?: number; contexts?: number } = {}): Profile {
  const topic = TOPICS.find((t) => t.skill === skill)!.id as TopicId
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3600_000).toISOString()
    p = recordGraded(p, {
      meta: { topic, skill, difficulty, ctx: `c${i % (o.contexts ?? 2)}` }, outcome: o.right === false ? 'incorrect' : 'correct',
      label: 'q', session: `L${i % (o.lessons ?? 2)}`, at, format: 'click'
    }).profile
  }
  return p
}

/** The number alone, with no graded proof behind it (as a tutor override or old data would give). */
function practised(p: Profile, skill: SkillId, n: number, difficulty: 1 | 2 | 3, right = true): Profile {
  let s = p.skills[skill]
  for (let i = 0; i < n; i++) s = applyEvidence(s, right ? 'correct' : 'incorrect', difficulty, 'test')
  return { ...p, skills: { ...p.skills, [skill]: s } }
}

describe('the targets match how the app grades', () => {
  it('steady right answers at medium difficulty reach strong but not top; at the hardest, top', () => {
    const base = createProfile('A', { experience: 'basics' })
    const medium = skillStanding(graded(base, 'chart_basics', 30, 2), NOW)[0]
    expect(medium.status).toBe('strong')
    expect(medium.mastery).toBeLessThan(BENCHMARKS.top.mastery)
    const hard = skillStanding(graded(base, 'chart_basics', 30, 3), NOW)[0]
    expect(hard.status).toBe('top')
    // Easy questions alone never get you to strong.
    const easy = skillStanding(graded(base, 'chart_basics', 30, 1), NOW)[0]
    expect(easy.mastery).toBeLessThan(BENCHMARKS.strong.mastery)
  })

  it('a strong number without graded proof is only provisional, and says what proof is missing', () => {
    const base = createProfile('A', { experience: 'basics' })
    const bare = skillStanding(practised(base, 'chart_basics', 30, 2), NOW)[0]
    expect(bare.status).toBe('provisional')
    expect(bare.proof.missing).toBe(`${PROOF.strong.right} more right answers, in another lesson, one at medium level or harder, in a different situation`)
    const oneLesson = skillStanding(graded(base, 'chart_basics', 30, 2, { lessons: 1 }), NOW)[0]
    expect(oneLesson.status).toBe('provisional')
    expect(oneLesson.proof.missing).toBe('in another lesson')
    const onePattern = skillStanding(graded(base, 'chart_basics', 30, 2, { contexts: 1 }), NOW)[0]
    expect(onePattern.proof.missing).toBe('in a different situation')
    // Strong, and on the way to top: the hardest level is what's missing.
    expect(skillStanding(graded(base, 'chart_basics', 30, 2), NOW)[0].proof.missing).toBe('one at the hardest level')
    expect(overall(skillStanding(practised(base, 'chart_basics', 30, 3), NOW)).atStrong).toBe(0)
  })

  it('the "how sure" range narrows with evidence', () => {
    const base = createProfile('A')
    const before = skillStanding(base, NOW)[0]
    const after = skillStanding(practised(base, 'chart_basics', 8, 2), NOW)[0]
    expect(before.high - before.low).toBeGreaterThan(after.high - after.low)
    expect(before.status).toBe('unmeasured')
  })
})

describe('where you stand', () => {
  it('a self-reported starting guess locks nothing: nothing is measured yet', () => {
    const rows = skillStanding(createProfile('A', { experience: 'new' }), NOW)
    expect(rows.filter((r) => r.status === 'locked')).toEqual([])
    expect(rows.every((r) => r.status === 'unmeasured')).toBe(true)
  })

  it('locks skills whose measured prerequisites are weak, even after a stray answer on them; reaching a target unlocks', () => {
    // Wrong answers on the moves: measured, and weak.
    const p = practised(createProfile('A', { experience: 'new' }), 'lumped_moves', 3, 1, false)
    const rows = skillStanding(p, NOW)
    expect(rows.find((r) => r.id === 'l_match')!.status).toBe('locked')
    expect(rows.find((r) => r.id === 'l_match')!.needs).toEqual(['lumped_moves'])
    // From the screenshot review: one answer on Q & bandwidth must not let it jump ahead of L-matching.
    expect(skillStanding(practised(p, 'l_match', 1, 1), NOW).find((r) => r.id === 'l_match')!.status).toBe('locked')
    let q = practised(p, 'lumped_moves', 12, 2)
    q = practised(q, 'reflection', 12, 2)
    expect(skillStanding(q, NOW).find((r) => r.id === 'l_match')!.status).not.toBe('locked')
    const tl = practised(p, 'tlines', 3, 1, false)
    expect(skillStanding(tl, NOW).find((r) => r.id === 'stubs')!.status).toBe('locked')
    expect(skillStanding(graded(tl, 'stubs', 30, 3), NOW).find((r) => r.id === 'stubs')!.status).toBe('top')
  })

  it('candidates never include a skill behind weak prerequisites', () => {
    let p = createProfile('A', { experience: 'basics' })
    p = practised(p, 'l_match', 2, 1, false)
    p = practised(p, 'q_bandwidth', 1, 1)
    expect(candidates(p, skillStanding(p, NOW)).map((c) => c.id)).not.toContain('q_bandwidth')
  })

  it('the tutor gets the same facts the page draws, and is told the pick is its own', () => {
    let p = createProfile('A', { experience: 'basics' })
    p = graded(p, 'chart_basics', 30, 3)
    p = practised(p, 'lumped_moves', 2, 1, false)
    p = practised(p, 'tlines', 30, 2)
    const text = standingForTutor(p, NOW)
    expect(text).toMatch(/strong 75% = gets medium-difficulty tasks right every time; top 95%/)
    expect(text).toMatch(/1\/9 skills at strong, 1 at top/)
    expect(text).toMatch(/chart_basics top; reflection not measured yet/)
    expect(text).toMatch(/l_match best after lumped_moves \(below 50%; a quick check of it first, not a wall\)/)
    expect(text).toMatch(/tlines provisional \(the number says strong; still needs 3 more right answers/)
    expect(text).toMatch(/Candidates by the numbers \(evidence for your pick, not the pick\)/)
  })

  it('counts skills at the targets and says what the next milestone is', () => {
    let p = createProfile('A')
    p = graded(p, 'chart_basics', 30, 3)
    p = graded(p, 'reflection', 30, 2)
    const o = overall(skillStanding(p, NOW))
    expect(o.atTop).toBe(1)
    expect(o.atStrong).toBe(2)
    expect(o.headline).toMatch(/2 of 9 skills at strong level/)
  })

  it('work on next: open gaps first, pushed up by misconceptions and due reviews, never a locked or strong skill', () => {
    let p = createProfile('A', { experience: 'basics' })
    p = graded(p, 'chart_basics', 30, 2)
    p = practised(p, 'reflection', 4, 1)
    p = practised(p, 'admittance', 6, 2)
    // A wrong answer on a shunt-L move: a misconception and a review due tomorrow-ish (box 1).
    p = recordGraded(p, { meta: { topic: 'dir_shuntL', skill: 'lumped_moves', difficulty: 1 }, outcome: 'incorrect', label: 'q', session: 's1', at: '2026-10-01T00:00:00.000Z', misconception: 'Thinks a shunt L moves clockwise' }).profile
    const rows = skillStanding(p, NOW)
    const picks = candidates(p, rows)
    expect(picks.map((f) => f.id)).not.toContain('chart_basics')
    expect(picks.every((f) => rows.find((r) => r.id === f.id)!.status !== 'locked')).toBe(true)
    const lumped = picks.find((f) => f.id === 'lumped_moves')!
    expect(picks[0].id).toBe('lumped_moves')
    expect(lumped.reasons.join(' | ')).toMatch(/1 misconception to clear \| 1 review due \| \d+ points to strong \| opens up/)
  })
})

describe('topics', () => {
  let n = 0
  const answer = (p: Profile, topic: TopicId, difficulty: 1 | 2 | 3, ok: boolean, at: string, ctx = `c${n++ % 2}`) =>
    recordGraded(p, { meta: { topic, skill: topic === 'plot_z' ? 'chart_basics' : 'reflection', difficulty, ctx }, outcome: ok ? 'correct' : 'incorrect', label: 'q', session: at, at }).profile

  it('untried, shaky, then strong once solid at level 2, top at level 3', () => {
    let p = createProfile('A', { experience: 'new' })
    const state = () => topicStanding(p, NOW).find((t) => t.id === 'plot_z')!.state
    expect(state()).toBe('untried')
    p = answer(p, 'plot_z', 1, false, '2026-10-01T00:00:00.000Z')
    expect(state()).toBe('shaky')
    for (let i = 0; i < 12; i++) p = answer(p, 'plot_z', 2, true, `2026-10-0${2 + (i % 5)}T0${i % 10}:00:00.000Z`)
    expect(['strong', 'top']).toContain(state())
    for (let i = 0; i < 6; i++) p = answer(p, 'plot_z', 3, true, `2026-10-06T1${i}:00:00.000Z`)
    expect(state()).toBe('top')
    expect(topicStanding(p, NOW).filter((t) => t.skill === 'chart_basics')).toHaveLength(2)
  })

  it('right every time but always in the same situation stays "building"', () => {
    let p = createProfile('A', { experience: 'new' })
    for (let i = 0; i < 10; i++) p = answer(p, 'plot_z', 3, true, `2026-10-0${1 + (i % 5)}T0${i}:00:00.000Z`, 'upper half')
    expect(topicStanding(p, NOW).find((t) => t.id === 'plot_z')!.state).toBe('building')
    p = answer(p, 'plot_z', 3, true, '2026-10-06T09:00:00.000Z', 'lower half')
    expect(topicStanding(p, NOW).find((t) => t.id === 'plot_z')!.state).toBe('top')
  })
})

describe('how long the targets take', () => {
  it('strong takes about 8–10 steady medium answers from a typical start; top needs hard ones', () => {
    const base = createProfile('A', { experience: 'basics' })
    const answersTo = (difficulty: 1 | 2 | 3, target: number) => {
      for (let n = 1; n <= 60; n++) if (practised(base, 'reflection', n, difficulty).skills.reflection.mastery >= target) return n
      return Infinity
    }
    const strong = answersTo(2, BENCHMARKS.strong.mastery)
    expect(strong).toBeGreaterThanOrEqual(6)
    expect(strong).toBeLessThanOrEqual(12)
    expect(answersTo(2, BENCHMARKS.top.mastery)).toBe(Infinity)
    expect(answersTo(3, BENCHMARKS.top.mastery)).toBeLessThanOrEqual(25)
  })
})
