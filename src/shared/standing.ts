/**
 * Where a learner stands, compared with two targets, and what to work on next.
 *
 * The targets come from the app's own grading, not from other learners: mastery
 * settles where a learner's right answers are pitched (applyEvidence aims at
 * 0.6 / 0.8 / 1.0 for right answers at difficulty 1 / 2 / 3). So
 *  - STRONG = right every time at medium difficulty. Those answers approach 0.8 but
 *    never reach it, so the mark is 0.75 (about 8–10 steady right answers),
 *  - TOP    = right at the hardest difficulty too (0.95; only hard answers get there).
 * Per topic the same split shows as the aim level: 2 for strong, 3 for top.
 */
import { SKILLS, skillName, type Profile, type SkillId } from './profile'
import { meetsProof, PROOF, recentScore, topicState, TOPICS, type TopicId, type TopicState, type TopicStat } from './memory'

export { PROOF }
import { isLive, patternsOf } from './patterns'

export type { TopicState }

export const BENCHMARKS = {
  strong: { mastery: 0.75, label: 'Strong', meaning: 'gets medium-difficulty tasks right every time' },
  top: { mastery: 0.95, label: 'Top', meaning: 'gets the hardest tasks right too' }
} as const

/** The level bands of overallLevel, for drawing the scale. */
export const ZONES = [
  { from: 0, to: 0.3, label: 'Beginner' },
  { from: 0.3, to: 0.55, label: 'Developing' },
  { from: 0.55, to: 0.8, label: 'Proficient' },
  { from: 0.8, to: 1, label: 'Advanced' }
] as const


export interface Proof {
  right: number
  lessons: number
  hardest: number
  contexts: number
  strong: boolean
  top: boolean
  /** What is still missing for the next target, in words ("2 more right answers, in another lesson") */
  missing: string
}

/** The proof behind a skill: its topics' unaided right answers, put together. */
export function proofFor(p: Profile, skill: SkillId): Proof {
  const entries = TOPICS.filter((t) => t.skill === skill).flatMap((t) => p.topics?.[t.id as TopicId]?.rightIn ?? [])
  const right = entries.length
  const lessons = new Set(entries.map((e) => e.session)).size
  const hardest = Math.max(0, ...entries.map((e) => e.d ?? 1))
  const contexts = new Set(entries.map((e) => e.ctx ?? '')).size
  const meets = (g: (typeof PROOF)['strong' | 'top']) => meetsProof(entries, g)
  const strong = meets(PROOF.strong)
  const top = meets(PROOF.top)
  const goal = strong ? PROOF.top : PROOF.strong
  const gaps: string[] = []
  if (right < goal.right) gaps.push(`${goal.right - right} more right answer${goal.right - right > 1 ? 's' : ''}`)
  if (lessons < goal.lessons) gaps.push('in another lesson')
  if (hardest < goal.minDifficulty) gaps.push(goal.minDifficulty >= 3 ? 'one at the hardest level' : 'one at medium level or harder')
  if (contexts < goal.contexts) gaps.push('in a different situation')
  return { right, lessons, hardest, contexts, strong, top, missing: gaps.join(', ') }
}

export type SkillStatus = 'locked' | 'unmeasured' | 'starting' | 'building' | 'provisional' | 'strong' | 'top'

export interface SkillStanding {
  id: SkillId
  name: string
  mastery: number
  /** How sure the estimate is, as a range (wide with little evidence) */
  low: number
  high: number
  confidence: number
  status: SkillStatus
  /** Mastery points to the targets (0 once reached) */
  toStrong: number
  toTop: number
  /** Weak prerequisites, when it is locked */
  needs: SkillId[]
  /** Graded proof behind the number */
  proof: Proof
  topicsTried: number
  topicsTotal: number
  dueReviews: number
  openMisconceptions: number
  /** Live patterns (patterns.ts) with a slip in this skill's topics */
  patterns: string[]
}

const clamp = (v: number) => Math.min(1, Math.max(0, v))

/** There is real evidence for a skill: graded or observed answers, or the placement test. */
export const measured = (s: { evidence: number; confidence: number }) => s.evidence > 0 || s.confidence >= 0.3

/** Uncertainty of a mastery estimate: ±0.3 with no evidence, shrinking to 0 as confidence grows. */
export const spread = (confidence: number) => 0.3 * (1 - clamp(confidence))

export function skillStanding(p: Profile, now: string): SkillStanding[] {
  const live = patternsOf(p).filter(isLive)
  return SKILLS.map((s) => {
    const st = p.skills[s.id]
    const m = st.mastery
    // A prerequisite holds a skill back only when it is measured and weak: a self-reported
    // starting guess (no answers, no placement test) says nothing about it yet.
    const needs = s.prerequisites.filter((pr) => p.skills[pr].mastery < 0.5 && measured(p.skills[pr]))
    const topics = TOPICS.filter((t) => t.skill === s.id)
    const stats = topics.map((t) => p.topics?.[t.id as TopicId]).filter((x): x is TopicStat => !!x)
    const proof = proofFor(p, s.id)
    // Reaching a target (with proof) counts whatever the order; otherwise a skill waits for its prerequisites.
    const status: SkillStatus =
      m >= BENCHMARKS.top.mastery && proof.top ? 'top'
      : m >= BENCHMARKS.strong.mastery && proof.strong ? 'strong'
      : m >= BENCHMARKS.strong.mastery ? 'provisional'
      : needs.length ? 'locked'
      : st.evidence === 0 && st.confidence < 0.3 ? 'unmeasured'
      : m >= 0.55 ? 'building'
      : 'starting'
    return {
      id: s.id,
      name: s.name,
      mastery: m,
      low: clamp(m - spread(st.confidence)),
      high: clamp(m + spread(st.confidence)),
      confidence: st.confidence,
      status,
      toStrong: Math.max(0, BENCHMARKS.strong.mastery - m),
      toTop: Math.max(0, BENCHMARKS.top.mastery - m),
      needs,
      proof,
      topicsTried: stats.length,
      topicsTotal: topics.length,
      dueReviews: stats.filter((t) => t.due <= now).length,
      openMisconceptions: p.misconceptions.filter((x) => !x.resolved && x.skill === s.id).length,
      patterns: live.filter((x) => x.topics.some((t) => topics.some((d) => d.id === t))).map((x) => x.name)
    }
  })
}

export interface Overall {
  avg: number
  level: string
  atStrong: number
  atTop: number
  total: number
  /** One line: where they are and the next milestone */
  headline: string
}

export function overall(rows: SkillStanding[]): Overall {
  const avg = rows.reduce((a, r) => a + r.mastery, 0) / Math.max(1, rows.length)
  const level = ZONES.find((z) => avg < z.to || z.to === 1)!.label
  // Only proven skills count: a provisional one isn't strong yet.
  const atStrong = rows.filter((r) => r.status === 'strong' || r.status === 'top').length
  const atTop = rows.filter((r) => r.status === 'top').length
  const total = rows.length
  const headline = atTop === total
    ? 'Top level in every skill.'
    : atStrong === total
      ? `Strong in every skill. ${total - atTop} to go for top level.`
      : `${atStrong} of ${total} skills at strong level. Next milestone: ${Math.min(total, atStrong + 1)}.`
  return { avg, level, atStrong, atTop, total, headline }
}

export interface Candidate {
  id: SkillId
  name: string
  /** The facts for it, in a few words each */
  reasons: string[]
  score: number
}

/**
 * Skills worth working on, by the numbers: open (prerequisites in place) and below
 * strong, ranked by the gap, with a push for live misconceptions, reviews that are
 * due and skills that open up others. This is evidence for the tutor, which makes
 * the actual pick (set_next_focus); the app never picks for the learner.
 */
export function candidates(p: Profile, rows: SkillStanding[], n = 4): Candidate[] {
  void p
  const below = new Set(rows.filter((r) => r.status !== 'strong' && r.status !== 'top').map((r) => r.id))
  return rows
    .filter((r) => r.needs.length === 0 && r.status !== 'strong' && r.status !== 'top')
    .map((r) => {
      const unlocks = SKILLS.filter((s) => s.prerequisites.includes(r.id) && below.has(s.id)).map((s) => s.name)
      const reasons: string[] = []
      if (r.patterns.length) reasons.push(`part of a pattern: ${r.patterns[0].charAt(0).toLowerCase()}${r.patterns[0].slice(1)}`)
      if (r.openMisconceptions) reasons.push(`${r.openMisconceptions} misconception${r.openMisconceptions > 1 ? 's' : ''} to clear`)
      if (r.dueReviews) reasons.push(`${r.dueReviews} review${r.dueReviews > 1 ? 's' : ''} due`)
      if (r.status === 'unmeasured') reasons.push('not measured yet: a few questions will place you')
      else if (r.status === 'provisional') reasons.push(`provisional: needs ${r.proof.missing}`)
      else reasons.push(`${Math.round(r.toStrong * 100)} points to strong`)
      if (unlocks.length) reasons.push(`opens up ${unlocks.slice(0, 2).join(', ')}`)
      const score = (r.status === 'provisional' ? 0.15 : r.toStrong) + 0.25 * Math.min(1, r.patterns.length) + 0.2 * Math.min(2, r.openMisconceptions) + 0.15 * Math.min(2, r.dueReviews) + 0.08 * unlocks.length + (r.status === 'unmeasured' ? 0.1 : 0)
      return { id: r.id, name: r.name, reasons, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

export interface TopicStanding {
  id: TopicId
  skill: SkillId
  name: string
  state: TopicState
  /** Aim level 1–3 (where the next question is pitched) */
  level: number
  seen: number
  correct: number
  recent: number
  due: boolean
}

/** Every topic, with how it is going (memory.ts topicState: the one rule). */
export function topicStanding(p: Profile, now: string): TopicStanding[] {
  return TOPICS.map((t) => {
    const st: TopicStat | undefined = p.topics?.[t.id as TopicId]
    return {
      id: t.id as TopicId, skill: t.skill, name: t.name, state: topicState(st),
      level: st?.level ?? 0, seen: st?.seen ?? 0, correct: st?.correct ?? 0,
      recent: st ? recentScore(st) : 0, due: !!st && st.due <= now
    }
  })
}

/**
 * Where they stand, for the tutor: the targets, each skill's gap or status, and the
 * candidates by the numbers. The same facts the Progress page draws.
 */
export function standingForTutor(p: Profile, now: string): string {
  const rows = skillStanding(p, now)
  const o = overall(rows)
  const status = (r: SkillStanding) =>
    r.status === 'top' ? 'top' : r.status === 'strong' ? `strong, ${Math.round(r.toTop * 100)} to top`
    : r.status === 'locked' ? `locked until ${r.needs.join(' and ')} reach 50%`
    : r.status === 'unmeasured' ? 'not measured yet'
    : r.status === 'provisional' ? `provisional (the number says strong; still needs ${r.proof.missing})`
    : `${Math.round(r.toStrong * 100)} to strong`
  const lines = [
    `Standing (targets: strong ${Math.round(BENCHMARKS.strong.mastery * 100)}% = ${BENCHMARKS.strong.meaning}; top ${Math.round(BENCHMARKS.top.mastery * 100)}% = ${BENCHMARKS.top.meaning}): ${o.atStrong}/${o.total} skills at strong, ${o.atTop} at top. The learner sees this on their Progress page.`,
    `- ${rows.map((r) => `${r.id} ${status(r)}`).join('; ')}`
  ]
  const c = candidates(p, rows)
  if (c.length) lines.push(`Candidates by the numbers (evidence for your pick, not the pick): ${c.map((x) => `${x.id} (${x.reasons.join(', ')})`).join('; ')}`)
  return lines.join('\n')
}

/**
 * What a "check yourself" session tests: skills whose number runs ahead of the proof
 * (provisional first), then measured skills with little proof. At most three.
 */
export function probeTargets(rows: SkillStanding[]): SkillStanding[] {
  const thin = (r: SkillStanding) => r.proof.right < PROOF.strong.right || r.proof.lessons < PROOF.strong.lessons || r.proof.contexts < PROOF.strong.contexts || r.proof.hardest < PROOF.strong.minDifficulty
  const open = rows.filter((r) => r.status !== 'locked' && r.status !== 'unmeasured' && r.status !== 'top')
  return [
    ...open.filter((r) => r.status === 'provisional'),
    ...open.filter((r) => r.status !== 'provisional' && thin(r)).sort((a, b) => b.mastery - a.mastery)
  ].slice(0, 3)
}

/** The tutor's current pick, ready to show: each skill with its standing (absent ones dropped). */
export function plannedFocus(p: Profile, rows: SkillStanding[]) {
  return (p.nextFocus?.picks ?? [])
    .map((pick) => ({ ...pick, name: skillName(pick.skill), row: rows.find((r) => r.id === pick.skill) }))
    .filter((x): x is typeof x & { row: SkillStanding } => !!x.row)
}
