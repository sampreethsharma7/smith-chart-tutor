import { describe, expect, it } from 'vitest'
import { c } from './rf/complex'
import { gammaFromZ } from './rf/metrics'
import { gradeQuestion, type QuestionKey } from './rf/tasks'
import { createProfile, migrateProfile } from './profile'
import { answerFor, chanceRight, chatLine, independenceSteps, itemLevel, itemSignature, learn, rng, scoreCourse, type CourseInput, type CourseItem, type CourseLesson } from './course'

const AT = '2026-10-09T12:00:00.000Z'
const KEYS: Record<string, QuestionKey> = {
  locate: { type: 'locate', target: gammaFromZ(c(0.5, 1), 1), tol: 0.06, targetText: 'z = 0.5 + j1' },
  locateReal: { type: 'locate', target: gammaFromZ(c(2, 0), 1), tol: 0.06, targetText: 'z = 2' },
  vswr: { type: 'value', quantity: 'vswr', expected: 2.04, tolPct: 8, z0: 50 },
  z: { type: 'value', quantity: 'z', expected: c(0.6, -0.4), tolPct: 8, z0: 50 },
  move: { type: 'move', choices: ['Up', 'Down', 'Left'], correct: 1, facts: 'Shunt C: z …', reasons: { choices: ['a', 'b'], correct: 0, ideas: ['', 'x'] } },
  component: { type: 'component', part: 'C', value: 1.2e-12, tolPct: 10, facts: '', z0: 50 },
  pick: { type: 'pick', choices: ['Step 1', 'Step 2', 'Step 3'], correct: 2, facts: 'step 3' }
}

describe('the scripted learner', () => {
  it('the same seed gives the same dice', () => {
    const a = rng(7), b = rng(7), d = rng(8)
    const xs = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(xs)
    expect(d()).not.toBe(xs[0])
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })

  it('answers every kind of graded card right or wrong as intended, by the app\'s own grading', () => {
    const r = rng(1)
    for (const [name, key] of Object.entries(KEYS)) {
      for (const right of [true, false]) {
        for (let i = 0; i < 20; i++) {
          const a = answerFor(key, right, r)
          expect(a, `${name} ${right}`).not.toBeNull()
          expect(gradeQuestion(key, a!).status === 'correct', `${name} ${right}`).toBe(right)
        }
      }
    }
  })

  it('wrong answers are the beginner\'s usual ones: the mirror point, the sign of x flipped', () => {
    const a = answerFor(KEYS.locate, false, rng(3))!
    const t = (KEYS.locate as { target: { re: number; im: number } }).target
    expect(a.gamma!.re).toBeCloseTo(t.re)
    expect(a.gamma!.im).toBeCloseTo(-t.im)
    expect(answerFor(KEYS.z, false, rng(3))!.text).toBe('0.6 + j0.4')
  })

  it('harder, more independent and covered items are harder; help and uncovering make them easier; practice helps', () => {
    const base = chanceRight(0.4, {})
    expect(chanceRight(0.4, { difficulty: 3 })).toBeLessThan(base)
    expect(chanceRight(0.4, { rung: 4 })).toBeLessThan(base)
    expect(chanceRight(0.4, { covered: true })).toBeLessThan(base)
    expect(chanceRight(0.4, { covered: true, revealed: true })).toBeGreaterThan(chanceRight(0.4, { covered: true }))
    expect(chanceRight(0.4, { helped: true })).toBeGreaterThan(base)
    expect(chanceRight(0, { difficulty: 3, rung: 5 })).toBe(0.05)
    expect(chanceRight(1, { helped: true })).toBe(0.95)
    expect(learn(0.3, true)).toBeGreaterThan(learn(0.3, false))
    expect(learn(0.3, false)).toBeGreaterThan(0.3)
  })

  it('chat: asks for practice after two messages without a card, says yes to a question', () => {
    const r = rng(1)
    expect(chatLine({ asked: false, lastMissed: false, streak: 0, sinceCard: 2 }, r)).toMatch(/question to try|practise/)
    expect(chatLine({ asked: true, lastMissed: false, streak: 0, sinceCard: 0 }, () => 0.9)).toMatch(/yes|sure/)
  })

  it('an item is the thing asked, not its wording', () => {
    expect(itemSignature(KEYS.locate)).toBe(itemSignature({ ...KEYS.locate, targetText: 'the point 0.5 + j1' } as QuestionKey))
    expect(itemSignature(KEYS.vswr)).not.toBe(itemSignature({ ...KEYS.vswr, expected: 3 } as QuestionKey))
    // review: the same element and answer from another start point is another question
    expect(itemSignature({ ...KEYS.move, facts: 'Shunt C 1 pF: from z = 0.6 + j0.4 to …' } as QuestionKey)).not.toBe(itemSignature({ ...KEYS.move, facts: 'Shunt C 1 pF: from z = 2 − j1 to …' } as QuestionKey))
  })

  it('independence steps count confirmed rungs above guided and reading from the chart, not estimates', () => {
    const p = migrateProfile(createProfile('X', { experience: 'new' }))
    const q = {
      ...p,
      ladder: { l_match: { rung: 3 as const, streak: 0, misses: 0, tries: 0, source: 'answers' as const, at: AT }, stubs: { rung: 4 as const, streak: 0, misses: 0, tries: 0, source: 'related' as const, provisional: true, at: AT } },
      reading: { reflection: { stage: 'chart' as const, streak: 0, misses: 0, source: 'answers' as const, at: AT }, admittance: { stage: 'readout' as const, streak: 0, misses: 0, source: 'answers' as const, at: AT } }
    }
    expect(independenceSteps(q)).toBe(3)
  })
})

const lesson = (n: number, x: Partial<CourseLesson> = {}): CourseLesson =>
  ({ n, ended: 'goal', skills: [], actions: 10, cards: 3, tasks: 0, stalls: 0, unsolved: 0, recap: true, requests: 25, tokens: 1000, ms: 60000, steps: 0, ...x })
const item = (lessonNo: number, x: Partial<CourseItem> = {}): CourseItem =>
  ({ lesson: lessonNo, sig: `s${Math.random()}`, kind: 'locate', difficulty: 1, outcome: 'correct', ...x })
const input = (x: Partial<CourseInput> = {}): CourseInput => ({
  lessons: [1, 2, 3, 4].map((n) => lesson(n, { steps: n })),
  items: [1, 2, 3, 4].flatMap((n) => [item(n, { difficulty: n <= 2 ? 1 : 2 }), item(n, { difficulty: n <= 2 ? 1 : 3 })]),
  issues: [],
  startSteps: 0,
  ...x
})

describe('scoring a course run (all counted, nothing judged by a model)', () => {
  it('a course that gets harder, climbs, has no faults and finishes every lesson scores full marks', () => {
    const { scores, facts } = scoreCourse(input())
    expect(scores.rising).toBe(1)
    expect(scores.variety).toBe(1)
    expect(scores.clean).toBe(1)
    expect(scores.flow).toBe(1)
    expect(scores.finished).toBe(1)
    expect(scores.honest).toBeUndefined() // no reading items: not measured, left out of the overall
    expect(scores.overall).toBe(1)
    expect(facts.stepsGained).toBe(4)
    expect(facts.requests).toBe(100)
    expect(facts.levelByLesson).toEqual([0, 0, 0.75, 0.75])
  })

  it('a flat course with no climbing scores low on rising challenge; an easier second half lower still', () => {
    const flat = input({ lessons: [1, 2, 3, 4].map((n) => lesson(n)), items: [1, 2, 3, 4].map((n) => item(n, { skill: 'chart_basics' })) })
    expect(scoreCourse(flat).scores.rising).toBeCloseTo(0.25)
    const easier = input({ lessons: [1, 2, 3, 4].map((n) => lesson(n)), items: [1, 2, 3, 4].map((n) => item(n, { skill: 'chart_basics', difficulty: n <= 2 ? 3 : 1 })) })
    expect(scoreCourse(easier).scores.rising).toBe(0)
  })

  it('review: moving on to a new skill is rising, though its first rung is "guided" (levels compare within a skill)', () => {
    // Hard chart reading first, then guided L-matching: the old mean-of-levels called this falling.
    const items = [item(1, { skill: 'chart_basics', difficulty: 3 }), item(2, { skill: 'reflection', difficulty: 2 }), item(3, { skill: 'l_match', rung: 1 }), item(4, { skill: 'l_match', rung: 2 })]
    const { scores, facts } = scoreCourse(input({ items, lessons: [1, 2, 3, 4].map((n) => lesson(n)) }))
    expect(facts.lift).toBe(1)
    expect(scores.rising).toBe(0.5)
    // Back on an old skill at a lower level: not rising.
    const back = [item(1, { skill: 'l_match', rung: 3 }), item(3, { skill: 'l_match', rung: 1 })]
    expect(scoreCourse(input({ items: back, lessons: [1, 2, 3, 4].map((n) => lesson(n)) })).facts.lift).toBe(0)
  })

  it('review: a one-lesson run has no halves to compare, so rising is not scored (it used to cap the overall)', () => {
    const one = scoreCourse(input({ lessons: [lesson(1, { steps: 1 })], items: [item(1)] }))
    expect(one.scores.rising).toBeUndefined()
    expect(one.scores.overall).toBe(1)
    // Two halves but nothing graded in the second: climbing alone.
    expect(scoreCourse(input({ lessons: [lesson(1), lesson(2, { steps: 1 })], items: [item(1)] })).scores.rising).toBe(1)
  })

  it('an item asked again after a right answer is a repeat; asked again after a miss it is a re-check', () => {
    const items = [item(1, { sig: 'A', outcome: 'incorrect' }), item(1, { sig: 'A' }), item(2, { sig: 'A' }), item(2, { sig: 'B' })]
    const { facts, scores } = scoreCourse(input({ items }))
    expect(facts.duplicates).toBe(1)
    expect(scores.variety).toBeCloseTo(0.25)
  })

  it('reading from the chart: what the tutor chose counts (covered or shown), not what the learner then did', () => {
    const items = [item(1, { values: 'shown', cover: 'shown' }), item(3, { values: 'shown', cover: 'shown' }), item(4, { values: 'revealed', cover: 'covered' }),
      // review: typing the point on a card the tutor showed the values on is still "shown" by the tutor
      item(4, { values: 'typed', cover: 'shown' })]
    const { scores, facts } = scoreCourse(input({ items }))
    expect(scores.honest).toBeCloseTo((1 / 3) / 0.5)
    expect(facts.reading).toEqual({ shown: 2, revealed: 1, typed: 1 })
  })

  it('tasks the scripted learner could not solve are reported apart', () => {
    expect(scoreCourse(input({ lessons: [lesson(1, { unsolved: 2 }), lesson(2, { steps: 2 })] })).facts.unsolved).toBe(2)
  })

  it('leaks, false claims, loops, stalls and physics fixes each cost their score', () => {
    const issues = [
      { lesson: 1, kind: 'tool-name', detail: 'ask_value' },
      { lesson: 1, kind: 'guard', detail: 'reply about the machinery withdrawn' },
      { lesson: 2, kind: 'claims-drawing', detail: '' },
      { lesson: 2, kind: 'tool-error', detail: 'create_exercise' },
      { lesson: 2, kind: 'step-limit', detail: '12 steps' },
      { lesson: 3, kind: 'guard', detail: 'wrong direction rewritten (x)' },
      { lesson: 3, kind: 'guard', detail: 'move described without checking it (what_if)' }
    ]
    const { scores, facts } = scoreCourse(input({ issues, lessons: [1, 2, 3, 4].map((n) => lesson(n, { steps: n, stalls: n === 4 ? 1 : 0 })) }))
    expect(facts).toMatchObject({ leaks: 2, claims: 1, refusals: 1, loops: 3, stalls: 1, physicsFixes: 1 })
    expect(scores.clean).toBeCloseTo(1 - 2.5 / 8)
    expect(scores.flow).toBeCloseTo(1 - 6 / 32)
    expect(scores.physics).toBeCloseTo(1 - 1 / 8)
  })

  it('lessons that hit the action limit or failed are not finished', () => {
    const lessons = [lesson(1), lesson(2, { ended: 'cap' }), lesson(3, { ended: 'error' }), lesson(4)]
    expect(scoreCourse(input({ lessons })).scores.finished).toBe(0.5)
  })

  it('an item\'s level is its rung when it has one, else its difficulty', () => {
    expect(itemLevel({ rung: 5, difficulty: 1 })).toBe(1)
    expect(itemLevel({ difficulty: 2 })).toBe(0.5)
    expect(itemLevel({})).toBe(0)
  })
})
