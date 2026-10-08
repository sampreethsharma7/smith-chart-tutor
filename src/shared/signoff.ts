/**
 * When is a mistake really fixed? The way a good tutor judges it, not one rule for everyone:
 *
 * - This learner's track record: do their fixes stick (retention), do they pick things up quickly
 *   (pace), are they right when they say they're sure (calibration)? With little history, each is
 *   pulled toward the default, so a new learner gets the standard bar (two lessons) until their
 *   own record says otherwise.
 * - How deep this mistake is: seen once, or many times over several lessons; sure of it; or has it
 *   come back after being cleared before?
 * - How strong each lesson's evidence is: a right answer, more if they were sure, gave the right
 *   reason, or did it in a new situation (transfer). One lesson counts at most 1.5, so nothing
 *   clears from a single lesson unless this learner's record has earned a lower bar.
 * - Never the lesson it appeared in: being right minutes after a correction shows they followed,
 *   not that it's fixed.
 *
 * Cleared is provisional: a clean answer in a later lesson confirms it; a slip brings it back with
 * a higher bar. The app decides, from the record; the tutor reports it in these words.
 */
import { skillName, type Profile, type SkillId } from './profile'
// memory.ts imports this module too; topicDef is only used inside functions, so the cycle is safe.
import { topicDef, type TopicId, type TopicStat } from './memory'

export type SignOffStatus = 'active' | 'improving' | 'cleared' | 'confirmed'

/** The words the learner and the tutor use for each status. */
export const SIGNOFF_WORDS: Record<SignOffStatus, string> = {
  active: 'still there',
  improving: 'looking better',
  cleared: 'cleared, to re-check',
  confirmed: 'confirmed'
}

// ── This learner's track record, where the mistake is ───────────────────────

/**
 * The one tunable: how many answers' (or cleared mistakes') worth of weight the level above
 * carries at each step: default → this learner → the skill → the topic. Larger is more cautious
 * (the record has to be longer before it moves the bar); smaller trusts thin records sooner.
 * The same strength also weighs the whole adjustment by how much history there is.
 */
export const SHRINK_STRENGTH = 15

/** Where a mistake is: its topic (if it has one) and its skill. Patterns across skills use neither. */
export interface Scope {
  topic?: TopicId
  skill?: SkillId
}

type Layer = 'topic' | 'skill' | 'learner'

export interface Track {
  /** Share of cleared mistakes that came back, here (shrunk layer by layer toward the default) */
  relapse: number
  /** Share of graded answers right, here */
  pace: number
  /** Share of "sure" answers right, here */
  sureRight: number
  /** −1 (needs more drilling) … 0 (default) … +1 (quick, and it sticks) */
  factor: number
  /** How much history there is behind it: answers and cleared mistakes, overall and here */
  n: { answers: number; cleared: number; sure: number; here: number }
  /** Why, in a few words for the learner ("a higher bar: transmission lines have taken you a few tries") */
  why: string
}

/** What a new learner is assumed to have. */
const PRIOR = { relapse: 0.3, pace: 0.65, sureRight: 0.8 }
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const shrink = (hits: number, n: number, toward: number, k: number) => (hits + toward * k) / (n + k)

/** A rate estimated layer by layer: the learner's toward the default, the skill's toward the learner's, the topic's toward the skill's. */
function layered(counts: Record<Layer, { hits: number; n: number }>, prior: number, k: number) {
  const learner = shrink(counts.learner.hits, counts.learner.n, prior, k)
  const skill = shrink(counts.skill.hits, counts.skill.n, learner, k)
  const topic = shrink(counts.topic.hits, counts.topic.n, skill, k)
  return { rate: topic, rates: { learner, skill, topic } as Record<Layer, number>, n: { learner: counts.learner.n, skill: counts.skill.n, topic: counts.topic.n } as Record<Layer, number>, prior }
}

/**
 * This learner's record where the mistake is (scope): their topic record, shrunk toward their
 * skill record, shrunk toward their overall record, shrunk toward the default, each step with the
 * same strength. Someone quick with admittance but slow with lines gets a lower bar for an
 * admittance mistake and a higher one for a lines mistake; a topic they haven't tried follows its
 * skill, and a skill they haven't tried follows their overall record.
 */
export function trackOf(p: Profile, scope: Scope = {}, k = SHRINK_STRENGTH): Track {
  const skillOfTopic = (t?: string) => (t ? topicDef(t)?.skill : undefined)
  const skill = scope.skill ?? skillOfTopic(scope.topic)
  const inLayer = (layer: Layer, topic?: string, sk?: string) =>
    layer === 'learner' ? true : layer === 'skill' ? !!skill && (sk ?? skillOfTopic(topic)) === skill : !!scope.topic && topic === scope.topic
  const count = <T,>(items: T[], where: (x: T, layer: Layer) => boolean, n: (x: T) => number, hits: (x: T) => number) =>
    Object.fromEntries((['learner', 'skill', 'topic'] as Layer[]).map((l) => {
      const xs = items.filter((x) => where(x, l))
      return [l, { n: xs.reduce((a, x) => a + n(x), 0), hits: xs.reduce((a, x) => a + hits(x), 0) }]
    })) as Record<Layer, { hits: number; n: number }>

  // Retention: mistakes that were cleared at some point, and how often they came back.
  const ms = p.misconceptions ?? []
  const retention = count(ms, (m, l) => inLayer(l, m.topic, m.skill), (m) => (m.resolved || (m.relapses ?? 0) > 0 ? 1 : 0) + (m.relapses ?? 0), (m) => m.relapses ?? 0)
  // Pace: how often they're right on graded answers.
  const topics = Object.entries(p.topics ?? {}) as Array<[TopicId, TopicStat]>
  const pace = count(topics, ([t], l) => inLayer(l, t), ([, s]) => s.seen, ([, s]) => s.correct)
  // Calibration: when they say they're sure, are they right?
  const sure = (p.calibration ?? []).filter((c) => c.sure === 'sure')
  const calib = count(sure, (c, l) => inLayer(l, c.topic), () => 1, (c) => (c.right ? 1 : 0))

  const rel = layered(retention, PRIOR.relapse, k)
  const pc = layered(pace, PRIOR.pace, k)
  const sr = layered(calib, PRIOR.sureRight, k)
  const keeps = clamp((PRIOR.relapse - rel.rate) / PRIOR.relapse)
  const quick = clamp((pc.rate - PRIOR.pace) / (1 - PRIOR.pace))
  const judges = clamp((sr.rate - PRIOR.sureRight) / (1 - PRIOR.sureRight))
  // The whole is weighed by how much history there is (same strength), so a handful of answers,
  // one of them counted in pace and calibration both, can't move the bar.
  const history = pace.learner.n + 2 * retention.learner.n
  const factor = clamp((0.4 * keeps + 0.35 * quick + 0.25 * judges) * (history / (history + k)))

  // Why, in words: each clear reason, named after the most specific place that has its own record,
  // points that way, and is at least as far that way as the level above it (so it isn't just
  // borrowing the learner's overall record).
  type Rates = ReturnType<typeof layered>
  const parent: Record<'topic' | 'skill', Layer> = { topic: 'skill', skill: 'learner' }
  const where = (r: Rates, better: number): Layer =>
    (['topic', 'skill'] as const).find((l) => r.n[l] > 0 && (r.rates[l] - r.prior) * better > 0 && (r.rates[l] - r.rates[parent[l]]) * better >= 0) ?? 'learner'
  const topicName = scope.topic ? topicDef(scope.topic)?.name : undefined
  const skillLabel = skill ? skillName(skill) : undefined
  const subject = (l: Layer) => (l === 'topic' && topicName ? topicName : l !== 'learner' && skillLabel ? skillLabel : undefined)
  const sign = Math.sign(factor)
  const parts = [
    { v: 0.4 * keeps, rates: rel, better: -sign, // fewer relapses is better
      up: (s?: string) => (s ? `your fixes on ${s} usually stick` : 'you usually keep what you learn'),
      down: (s?: string) => (s ? `some fixes on ${s} have come back before` : 'some of your fixes have come back before') },
    { v: 0.35 * quick, rates: pc, better: sign,
      up: (s?: string) => (s ? `you pick up ${s} quickly` : 'you pick things up quickly'),
      down: (s?: string) => (s ? `you've needed a few tries on ${s}` : 'new topics have taken you a few tries') },
    { v: 0.25 * judges, rates: sr, better: sign,
      up: (s?: string) => (s ? `when you are sure about ${s}, you are right` : 'when you are sure, you are right'),
      down: (s?: string) => (s ? `you have been sure of wrong answers on ${s}` : 'you have been sure of wrong answers before') }
  ]
  const clear = parts.filter((x) => x.v * sign >= 0.075)
  const named = (clear.length ? clear : [...parts].sort((a, b) => b.v * sign - a.v * sign).slice(0, 1))
    .map((x) => (sign > 0 ? x.up : x.down)(subject(where(x.rates, x.better))))
  const bar = requiredFor({ factor } as Track, 0)
  const why = bar === 2
    ? history < k ? 'not much history yet, so the standard bar' : 'the standard bar'
    : `${bar < 2 ? 'a lower bar' : 'a higher bar'}: ${named.join('; ')}`
  return {
    relapse: rel.rate, pace: pc.rate, sureRight: sr.rate, factor,
    n: { answers: pace.learner.n, cleared: retention.learner.n, sure: calib.learner.n, here: (scope.topic ? pace.topic.n : pace.skill.n) },
    why
  }
}

// ── The evidence since a mistake was last seen ──────────────────────────────

/** One piece of evidence that the mistake is gone: a graded right answer, or the tutor's observation. */
export interface Evidence {
  session: string
  at: string
  kind: 'graded' | 'tutor'
  /** Graded: they said they were sure. Tutor: the observation was fully right. */
  sure?: boolean
  /** They gave the right reason (from the tutor's observation, or a graded reason) */
  reason?: boolean
  /** In a different situation from where the mistake was seen */
  transfer?: boolean
  /** A tutor observation that was only partly right */
  partial?: boolean
}

/** What a lesson's evidence is worth (0–1.5): a graded right answer is the core; confidence, the reason and transfer add to it. */
export function lessonStrength(items: Evidence[]): number {
  const graded = items.filter((e) => e.kind === 'graded')
  const tutor = items.filter((e) => e.kind === 'tutor')
  const base = graded.length ? 1 : tutor.some((e) => !e.partial) ? 0.5 : tutor.length ? 0.25 : 0
  if (!base) return 0
  const bonus = 0.25 * (graded.some((e) => e.sure) ? 1 : 0) + 0.25 * (items.some((e) => e.reason) ? 1 : 0) + 0.25 * (items.some((e) => e.transfer) ? 1 : 0)
  return Math.min(1.5, base + bonus)
}

// ── The decision ────────────────────────────────────────────────────────────

export interface MistakeDepth {
  /** Times seen */
  count: number
  /** Lessons it was seen in */
  lessons: number
  /** Times it came back after being cleared */
  relapses: number
  /** They were sure of the wrong answer */
  confident?: boolean
}

export interface SignOff {
  status: SignOffStatus
  /** Evidence so far, and what this learner needs for this mistake */
  points: number
  required: number
  /** Lessons with evidence since it was last seen (never the lesson it appeared in) */
  lessons: number
  /** The lesson whose evidence cleared it, if cleared */
  clearedIn?: string
  /** What's still needed, for the tutor ("one more clean answer in a later lesson, ideally in a new situation") */
  needed: string
  /** Why this bar, for the learner */
  why: string
}

/** 0 (a slip) … 2+ (deep): from how often, over how many lessons, how sure, and relapses. */
export function depthOf(d: MistakeDepth): number {
  const base = d.count >= 5 || d.lessons >= 4 ? 2 : d.count >= 3 || d.lessons >= 3 ? 1 : 0
  return base + (d.confident ? 0.5 : 0) + Math.min(2, d.relapses)
}

/** The evidence this learner needs for this mistake: 2 by default; 1.25 (one strong lesson) … 4. */
export function requiredFor(track: Track, depth: number): number {
  const r = 2 - 1.75 * track.factor + 0.5 * depth
  return Math.round(Math.min(4, Math.max(1.25, r)) * 4) / 4
}

/**
 * Decide, from the evidence since the mistake was last seen (already filtered: later lessons only),
 * this learner's track record, and how deep the mistake is.
 */
export function signOff(evidence: Evidence[], track: Track, depth: MistakeDepth): SignOff {
  const d = depthOf(depth)
  const required = requiredFor(track, d)
  // Lessons in order; each counts once, at the strength of its best evidence.
  const bySession = new Map<string, Evidence[]>()
  for (const e of [...evidence].sort((a, b) => a.at.localeCompare(b.at))) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e])
  const lessons = [...bySession.entries()].map(([session, items]) => ({ session, strength: lessonStrength(items), transfer: items.some((e) => e.transfer) })).filter((l) => l.strength > 0)
  // A deep mistake needs at least one lesson where they did it in a new situation.
  const needsTransfer = d >= 2
  let points = 0
  let sawTransfer = false
  let clearedAt = -1
  lessons.forEach((l, i) => {
    points += l.strength
    sawTransfer ||= l.transfer
    if (clearedAt < 0 && points >= required - 1e-9 && (!needsTransfer || sawTransfer)) clearedAt = i
  })
  // Cleared, then a clean lesson after that: confirmed.
  const confirmed = clearedAt >= 0 && lessons.slice(clearedAt + 1).some((l) => l.strength >= 1)
  const status: SignOffStatus = confirmed ? 'confirmed' : clearedAt >= 0 ? 'cleared' : points > 0 ? 'improving' : 'active'
  const left = Math.max(0, required - points)
  const needed =
    status === 'confirmed' ? 'nothing: it has held since it was cleared'
    : status === 'cleared' ? 'one clean answer in a later lesson to confirm it'
    : (left <= 1 ? 'one more clean answer in a later lesson'
      : left <= 1.5 ? 'one more strong answer in a later lesson (sure, with the reason, or in a new situation), or plain right answers in two'
      : `right answers in about ${Math.ceil(left)} more lessons (fewer if they're sure, give the reason, or do it in a new situation)`) +
      (needsTransfer && !sawTransfer ? ', including one in a new situation' : '')
  return { status, points, required, lessons: lessons.length, ...(clearedAt >= 0 ? { clearedIn: lessons[clearedAt].session } : {}), needed, why: track.why }
}

// ── Gathering the evidence ──────────────────────────────────────────────────

/** A tutor's structured observation (record_evidence): what it showed, the reason, and transfer. */
export interface Observation {
  at: string
  session: string
  skill: string
  topic?: TopicId
  /** A misconception it bears on */
  misconception?: string
  outcome: 'correct' | 'partial' | 'incorrect'
  /** Did they give the right reason? none = not asked or not given */
  reason: 'right' | 'partial' | 'wrong' | 'none'
  /** Was it in a new situation (different from where they learned or got it wrong)? */
  transfer: boolean
  note?: string
}

/**
 * The evidence on some topics after `after`, from later lessons only (`exclude`: the lessons the
 * mistake appeared in). seenIn: situations (ctx) and topics where it was seen, to tell transfer.
 */
export function gatherEvidence(
  p: Profile,
  o: { topics: TopicId[]; after: string; exclude: Set<string>; seenCtx?: Set<string>; seenTopics?: Set<TopicId>; misconception?: string }
): Evidence[] {
  const out: Evidence[] = []
  const transferOf = (topic: TopicId, ctx?: string) =>
    (!!o.seenTopics?.size && !o.seenTopics.has(topic)) || (!!ctx && !!o.seenCtx?.size && !o.seenCtx.has(ctx))
  for (const t of o.topics) {
    const stat = p.topics?.[t] as TopicStat | undefined
    for (const e of stat?.rightIn ?? []) {
      if (e.at < o.after || o.exclude.has(e.session)) continue
      out.push({ session: e.session, at: e.at, kind: 'graded', sure: !!e.sure, transfer: transferOf(t, e.ctx) })
    }
  }
  for (const ob of p.observations ?? []) {
    if (ob.at < o.after || o.exclude.has(ob.session) || ob.outcome === 'incorrect') continue
    const about = (o.misconception && ob.misconception === o.misconception) || (ob.topic && o.topics.includes(ob.topic))
    if (!about) continue
    out.push({ session: ob.session, at: ob.at, kind: 'tutor', reason: ob.reason === 'right', transfer: ob.transfer, partial: ob.outcome === 'partial' || ob.reason === 'partial' })
  }
  return out
}

/** The lesson running at a moment, for records saved before they kept their lesson. */
export function sessionAt(p: Profile, at: string): string | undefined {
  const s = [...(p.sessions ?? [])].reverse().find((x) => x.startedAt <= at)
  return s && (!s.endedAt || at <= s.endedAt || s === p.sessions.at(-1)) ? s.id : undefined
}
