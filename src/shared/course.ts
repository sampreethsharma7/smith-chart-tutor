/**
 * Course run: the tutor teaches a scripted beginner for several lessons, and code scores how the
 * teaching went (rising difficulty, repeats, copied answers, leaks, loops, wrong physics). The learner
 * is not a model: it has a hidden ability per skill that grows with practice and answers the app's
 * graded cards by chance from it, so only the tutor uses requests, and a seed makes its side repeatable.
 * Everything here is pure; the run itself is driven in the app (renderer state/course.ts).
 */
import { c, type Complex } from './rf/complex'
import { gradeQuestion, type QuestionAnswer, type QuestionKey } from './rf/tasks'
import type { Outcome, Profile, SkillId, Sure } from './profile'
import type { ValuesSeen } from './reading'

export const COURSE_VERSION = 1
export const DEFAULT_LESSONS = 6
/** A lesson stops after this many learner actions even if the goal wasn't reached */
export const MAX_ACTIONS = 30
/** Rough tutor requests a lesson takes (the novice test: 20–35), for the estimate shown before a run */
export const REQUESTS_PER_LESSON = { low: 20, high: 35 }
/** The run stops when it has used this many requests per lesson asked for */
export const REQUEST_CAP_PER_LESSON = 50

/** Seeded random numbers in [0, 1) (mulberry32): the same seed gives the same learner. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A new learner: some chart reading from a course, little else. */
export const START_ABILITY: Record<SkillId, number> = {
  chart_basics: 0.35, reflection: 0.25, admittance: 0.2, lumped_moves: 0.15, l_match: 0.1,
  tlines: 0.1, stubs: 0.05, q_bandwidth: 0.05, sweep_reading: 0.1
}

export interface ItemCtx {
  /** 1–3 (memory.ts) */
  difficulty?: number
  /** 1–5 on the independence ladder */
  rung?: number
  /** A reading question with the values covered (and not uncovered) */
  covered?: boolean
  /** They pressed "Show values" */
  revealed?: boolean
  /** They asked for help first */
  helped?: boolean
}

/** The chance of getting an item right: ability, less for harder and more independent items, more with help. */
export function chanceRight(ability: number, x: ItemCtx): number {
  const p = ability + 0.3 - 0.1 * ((x.difficulty ?? 1) - 1) - 0.07 * ((x.rung ?? 1) - 1) -
    (x.covered ? 0.1 : 0) + (x.revealed ? 0.25 : 0) + (x.helped ? 0.15 : 0)
  return Math.min(0.95, Math.max(0.05, p))
}

/** Practice moves ability up: more after a right answer, a little after feedback on a wrong one. */
export const learn = (ability: number, right: boolean): number => ability + (right ? 0.07 : 0.04) * (1 - ability)

/** How sure they say they are: sure of right answers as they get better; wrong ones mostly unsure or guessed, sometimes sure. */
export function sureOf(right: boolean, ability: number, r: () => number): Sure {
  const u = r()
  if (right) return u < 0.3 + 0.6 * ability ? 'sure' : 'unsure'
  return u < 0.2 ? 'sure' : u < 0.6 ? 'unsure' : 'guess'
}

const fmtC = (z: Complex) => `${round(z.re)} ${z.im < 0 ? '-' : '+'} j${round(Math.abs(z.im))}`
const round = (x: number) => Number(x.toPrecision(3))

/**
 * An answer to a graded card that the app grades as intended (right or wrong), checked with the
 * app's own grading. Wrong answers are the beginner's usual ones: the mirror point, a value off by
 * a lot, the wrong part. `text` is what goes in the answer box (or the choice); `gamma` a click.
 * Null when no answer of that kind could be made (the card is then skipped).
 */
export function answerFor(key: QuestionKey, right: boolean, r: () => number): (QuestionAnswer & { text: string }) | null {
  const pickOther = (n: number, not: number) => (not + 1 + Math.floor(r() * (n - 1))) % n
  for (let tries = 0; tries < 8; tries++) {
    let a: (QuestionAnswer & { text: string }) | null = null
    if (key.type === 'move') {
      const i = right ? key.correct : pickOther(key.choices.length, key.correct)
      const rs = key.reasons
      // A right answer comes with its right reason; a wrong one with any.
      const j = rs ? (right ? rs.correct : Math.floor(r() * rs.choices.length)) : -1
      a = { choice: key.choices[i], text: key.choices[i], ...(rs ? { reason: rs.choices[j] } : {}) }
    } else if (key.type === 'pick') {
      const i = right ? key.correct : pickOther(key.choices.length, key.correct)
      a = { choice: key.choices[i], text: key.choices[i] }
    } else if (key.type === 'locate') {
      const t = key.target
      const g = right
        ? polar(Math.min(0.98, Math.hypot(t.re, t.im) + (r() - 0.5) * key.tol * 0.6), Math.atan2(t.im, t.re) + (r() - 0.5) * key.tol * 0.6)
        // The mirror point (upper and lower half mixed up) if that's far enough, else a point well off.
        : Math.abs(t.im) > key.tol * 1.5 && tries < 4 ? c(t.re, -t.im) : polar(Math.min(0.95, Math.hypot(t.re, t.im) * 0.5 + 0.3), Math.atan2(t.im, t.re) + 1 + r())
      a = { gamma: g, text: `clicked Γ = ${fmtC(g)}` }
    } else if (key.type === 'value') {
      const e = key.expected
      if (typeof e === 'number') {
        const v = right ? e * (1 + (r() - 0.5) * 0.02) : e === 0 ? 0.5 + r() : e * (r() < 0.5 ? 1.5 + r() : 0.4 - 0.2 * r())
        a = { text: String(round(v)) }
      } else {
        // Wrong: the sign of the imaginary part flipped, or the parts swapped.
        const z = right ? c(e.re * (1 + (r() - 0.5) * 0.02), e.im * (1 + (r() - 0.5) * 0.02)) : Math.abs(e.im) > 0.1 && tries < 4 ? c(e.re, -e.im) : c(e.im + 0.5, e.re)
        a = { text: fmtC(z) }
      }
    } else if (key.type === 'component') {
      const wrongPart = !right && r() < 0.4
      const part = wrongPart ? (key.part === 'L' ? 'C' : 'L') : key.part
      const v = right ? key.value * (1 + (r() - 0.5) * 0.04) : wrongPart ? key.value : key.value * (r() < 0.5 ? 2.2 : 0.4)
      a = { text: part === 'L' ? `${round(v / 1e-9)} nH` : `${round(v / 1e-12)} pF` }
    }
    if (!a) return null
    const g = gradeQuestion(key, a)
    if (g.status === 'unreadable') continue
    if ((g.status === 'correct') === right) return a
  }
  return null
}

const polar = (m: number, th: number) => c(m * Math.cos(th), m * Math.sin(th))

/**
 * What makes two items "the same question": its kind and the exact thing asked (the point to find,
 * the quantity and its value, the verified move, the part and its size), not the wording.
 */
export function itemSignature(key: QuestionKey): string {
  const q = (x: number, step: number) => Math.round(x / step) * step
  switch (key.type) {
    case 'locate': return `locate:${q(key.target.re, 0.05).toFixed(2)},${q(key.target.im, 0.05).toFixed(2)}`
    case 'value': return `value:${key.quantity}:${typeof key.expected === 'number' ? round(key.expected) : fmtC(key.expected)}`
    // The verified move itself: the element, its size and where it starts and ends.
    case 'move': return `move:${key.facts.slice(0, 160)}`
    case 'component': return `component:${key.part}:${round(key.value)}`
    case 'pick': return `pick:${key.facts.slice(0, 80)}`
  }
}

/** A task, by what it asks: its kind, where the point starts (normalised), its goal and the parts allowed. */
export function taskSignature(kind: 'match' | 'reach', z: Complex, goal: string, kinds?: string[]): string {
  const q = (x: number) => (Math.round(x / 0.05) * 0.05).toFixed(2)
  return `task:${kind}:${q(z.re)},${q(z.im)}:${goal}:${[...(kinds ?? [])].sort().join('+')}`
}

/** Short beginner lines for when no card is open. */
export const CHAT = {
  next: ['ok', 'ok, got it', "what's next?", 'ok, makes sense', 'cool, go on'],
  lost: ["I don't really get it, can you explain it more simply?", "sorry, I'm lost. what does that mean on the chart?", 'can you show me an example?'],
  harder: ['can I try a harder one?', 'that felt easy, can we go further?'],
  practise: ['can you give me a question to try?', 'can I practise that?'],
  yes: ['yes, sounds good', 'sure, let’s do that']
}

export interface ChatCtx {
  /** The tutor's last reply asked them something or proposed something (ends in "?") */
  asked: boolean
  /** Their last graded answer was wrong */
  lastMissed: boolean
  /** Right answers in a row */
  streak: number
  /** Learner messages since the last card */
  sinceCard: number
}

/** What they say when no card is open: answer a question with yes, ask for practice when there's been talk for a while. */
export function chatLine(x: ChatCtx, r: () => number): string {
  const one = (xs: string[]) => xs[Math.floor(r() * xs.length)]
  if (x.sinceCard >= 2) return one(CHAT.practise)
  if (x.lastMissed && r() < 0.4) return one(CHAT.lost)
  if (x.streak >= 3 && r() < 0.5) return one(CHAT.harder)
  if (x.asked) return one(CHAT.yes)
  return one(CHAT.next)
}

/**
 * Independence steps they've confirmed with answers: each rung above "guided" on the ladder, and
 * each reading skill done from the chart rather than the readout. Estimates don't count.
 */
export function independenceSteps(p: Profile): number {
  let n = 0
  for (const l of Object.values(p.ladder ?? {})) if (l && l.source === 'answers' && !l.provisional) n += l.rung - 1
  for (const r of Object.values(p.reading ?? {})) if (r && r.source === 'answers' && !r.provisional && r.stage === 'chart') n += 1
  return n
}

// ---- the report --------------------------------------------------------------

export interface CourseLesson {
  n: number
  /** How it ended: the tutor reached its goal, the action cap, the learner stalled, or an error */
  ended: 'goal' | 'cap' | 'error' | 'stopped'
  goal?: string
  /** Skills of the graded items in it */
  skills: string[]
  actions: number
  cards: number
  tasks: number
  /** Stretches of 3+ learner messages without a card or task */
  stalls: number
  /** Tasks the scripted learner couldn't solve with the app's solvers (a gap in the script, not the tutor's fault) */
  unsolved: number
  recap: boolean
  requests: number
  tokens: number
  ms: number
  /** Independence steps (ladder rungs and reading stages, confirmed) at its end */
  steps: number
  error?: string
}

export interface CourseItem {
  lesson: number
  sig: string
  skill?: string
  difficulty?: number
  rung?: number
  values?: ValuesSeen
  /** Reading items: what the tutor chose (values covered or shown), whatever the learner then did */
  cover?: 'covered' | 'shown'
  outcome?: Outcome
  kind: string
}

export interface CourseIssue { lesson: number; kind: string; detail: string }

export interface CourseInput {
  lessons: CourseLesson[]
  items: CourseItem[]
  issues: CourseIssue[]
  /** Steps at the start (before lesson 1) */
  startSteps: number
  capstone?: { title: string; met: number; total: number; done: boolean }
}

export type CourseScore = 'rising' | 'variety' | 'honest' | 'clean' | 'flow' | 'physics' | 'finished'

export const COURSE_SCORES: Array<{ id: CourseScore; name: string; weight: number; what: string }> = [
  { id: 'rising', name: 'Rising challenge', weight: 0.25, what: 'In the second half, items are harder or more independent than in the first on the same skill, or on new ground; and the learner climbs independence steps' },
  { id: 'variety', name: 'No repeats', weight: 0.15, what: 'Few items repeat one already asked (unless to re-check a miss)' },
  { id: 'honest', name: 'Reading from the chart', weight: 0.1, what: 'In the later lessons, the tutor covers the values on reading questions instead of showing them' },
  { id: 'clean', name: 'Clean replies', weight: 0.15, what: 'No internal text reaches the learner (tool names, withheld replies), no claims of changes not made' },
  { id: 'flow', name: 'Smooth flow', weight: 0.15, what: 'Few refused tool calls, repeats, step limits, empty replies or stretches without practice' },
  { id: 'physics', name: 'Right physics', weight: 0.05, what: 'The app rarely had to correct a direction the tutor gave' },
  { id: 'finished', name: 'Lessons finished', weight: 0.15, what: 'Lessons reach their goal within the action limit' }
]

export interface CourseFacts {
  lessons: number
  items: number
  /** Mean item level per lesson (0 = easiest, guided; 1 = hardest, judge). Levels are per skill, so a lesson on a new skill can read lower */
  levelByLesson: Array<number | null>
  /** Second-half items above the first half on their skill (or on a skill new in the second half), 0..1 */
  lift: number | null
  unsolved: number
  stepsGained: number
  duplicates: number
  /** Reading answers by how the values were seen */
  reading: Partial<Record<ValuesSeen, number>>
  leaks: number
  claims: number
  refusals: number
  loops: number
  stalls: number
  physicsFixes: number
  finished: number
  requests: number
  tokens: number
  minutes: number
  correctShare: number | null
  capstone?: CourseInput['capstone']
}

export interface CourseReport {
  id: string
  version: number
  at: string
  providerId: string
  providerLabel: string
  model: string
  seed: number
  lessonsAsked: number
  /** Why it ended early, if it did */
  stopped?: string
  lessons: CourseLesson[]
  items: CourseItem[]
  issues: CourseIssue[]
  facts: CourseFacts
  scores: Partial<Record<CourseScore, number>> & { overall: number }
}

/** An item's level: its rung on the ladder (guided … judge), else its difficulty. 0..1. */
export const itemLevel = (x: Pick<CourseItem, 'rung' | 'difficulty'>): number => x.rung ? (x.rung - 1) / 4 : ((x.difficulty ?? 1) - 1) / 2

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

const LEAK = (i: CourseIssue) => i.kind === 'tool-name' || i.kind === 'escaped-newline' || (i.kind === 'guard' && /machinery/.test(i.detail))
const PHYSICS = (i: CourseIssue) => i.kind === 'guard' && /wrong direction/.test(i.detail)

/** Score a run from what happened. Every number is counted, none judged by a model. */
export function scoreCourse(x: CourseInput): { facts: CourseFacts; scores: CourseReport['scores'] } {
  const n = Math.max(1, x.lessons.length)
  const levelByLesson = x.lessons.map((l) => mean(x.items.filter((i) => i.lesson === l.n).map(itemLevel)))
  const half = Math.ceil(x.lessons.length / 2)
  // Each second-half item against the first half on its own skill (levels aren't comparable across
  // skills: a guided L-match is harder than a hard chart reading): above it 1, level with it ½, below 0.
  // A skill first met in the second half is new ground: 1.
  const firstBySkill = new Map<string, number[]>()
  for (const i of x.items) if (i.lesson <= half) firstBySkill.set(i.skill ?? '?', [...(firstBySkill.get(i.skill ?? '?') ?? []), itemLevel(i)])
  const later = x.items.filter((i) => i.lesson > half)
  const lift = later.length ? mean(later.map((i) => {
    const before = firstBySkill.get(i.skill ?? '?')
    if (!before) return 1
    const d = itemLevel(i) - mean(before)!
    return d > 0.05 ? 1 : d < -0.05 ? 0 : 0.5
  })) : null
  const stepsGained = (x.lessons.at(-1)?.steps ?? x.startSteps) - x.startSteps

  // A repeat: the same item as one asked before, unless the one before it was missed (asking again re-checks it).
  let duplicates = 0
  const seen = new Map<string, CourseItem>()
  for (const it of x.items) {
    const prev = seen.get(it.sig)
    if (prev && prev.outcome === 'correct') duplicates++
    seen.set(it.sig, it)
  }
  const reading: CourseFacts['reading'] = {}
  for (const it of x.items) if (it.values) reading[it.values] = (reading[it.values] ?? 0) + 1
  const lateReading = x.items.filter((i) => i.cover && i.lesson > half)
  const count = (f: (i: CourseIssue) => boolean) => x.issues.filter(f).length
  const leaks = count(LEAK)
  const claims = count((i) => i.kind === 'claims-drawing' || i.kind === 'claims-change')
  const refusals = count((i) => i.kind === 'tool-error')
  const loops = count((i) => i.kind === 'tool-repeat' || i.kind === 'empty-reply') + 3 * count((i) => i.kind === 'step-limit')
  const physicsFixes = count(PHYSICS)
  const stalls = x.lessons.reduce((a, l) => a + l.stalls, 0)
  const unsolved = x.lessons.reduce((a, l) => a + (l.unsolved ?? 0), 0)
  const finished = x.lessons.filter((l) => l.ended === 'goal').length
  const outcomes = x.items.filter((i) => i.outcome)

  const scores: CourseReport['scores'] = { overall: 0 }
  // Rising needs two halves to compare; a step gained every two lessons is full marks for climbing.
  if (x.lessons.length >= 2) {
    const climb = clamp01(stepsGained / (n / 2))
    scores.rising = lift === null ? climb : (lift + climb) / 2
  }
  if (x.items.length) scores.variety = clamp01(1 - (3 * duplicates) / x.items.length)
  if (lateReading.length) scores.honest = clamp01(lateReading.filter((i) => i.cover === 'covered').length / lateReading.length / 0.5)
  scores.clean = clamp01(1 - (leaks + claims / 2) / (2 * n))
  scores.flow = clamp01(1 - (refusals + loops + 2 * stalls) / (8 * n))
  scores.physics = clamp01(1 - physicsFixes / (2 * n))
  scores.finished = finished / n
  let w = 0, s = 0
  for (const d of COURSE_SCORES) {
    const v = scores[d.id]
    if (v === undefined) continue
    w += d.weight
    s += d.weight * v
  }
  scores.overall = w ? s / w : 0
  const facts: CourseFacts = {
    lessons: x.lessons.length,
    items: x.items.length,
    levelByLesson,
    lift,
    unsolved,
    stepsGained,
    duplicates,
    reading,
    leaks,
    claims,
    refusals,
    loops,
    stalls,
    physicsFixes,
    finished,
    requests: x.lessons.reduce((a, l) => a + l.requests, 0),
    tokens: x.lessons.reduce((a, l) => a + l.tokens, 0),
    minutes: Math.round(x.lessons.reduce((a, l) => a + l.ms, 0) / 6000) / 10,
    correctShare: outcomes.length ? outcomes.filter((i) => i.outcome === 'correct').length / outcomes.length : null,
    ...(x.capstone ? { capstone: x.capstone } : {})
  }
  return { facts, scores }
}
