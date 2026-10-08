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
import type { Profile } from './profile'
import type { TopicId, TopicStat } from './memory'

export type SignOffStatus = 'active' | 'improving' | 'cleared' | 'confirmed'

/** The words the learner and the tutor use for each status. */
export const SIGNOFF_WORDS: Record<SignOffStatus, string> = {
  active: 'still there',
  improving: 'looking better',
  cleared: 'cleared, to re-check',
  confirmed: 'confirmed'
}

// ── This learner's track record ─────────────────────────────────────────────

export interface Track {
  /** Share of cleared mistakes that came back (shrunk toward the default) */
  relapse: number
  /** Share of graded answers right (shrunk toward the default) */
  pace: number
  /** Share of "sure" answers right (shrunk toward the default) */
  sureRight: number
  /** −1 (needs more drilling) … 0 (default) … +1 (quick, and it sticks) */
  factor: number
  /** How much history there is behind it */
  n: { cleared: number; answers: number; sure: number }
  /** Why, in a few words for the learner ("you usually keep what you learn") */
  why: string
}

/** Defaults a new learner is assumed to have, and how many answers' worth of weight they carry. */
const PRIOR = { relapse: 0.3, relapseWeight: 3, pace: 0.65, paceWeight: 12, sureRight: 0.8, sureWeight: 6 }
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const shrink = (hits: number, n: number, prior: number, weight: number) => (hits + prior * weight) / (n + weight)

export function trackOf(p: Profile): Track {
  // Retention: mistakes that were cleared at some point, and how often they came back.
  const ms = p.misconceptions ?? []
  const relapses = ms.reduce((a, m) => a + (m.relapses ?? 0), 0)
  const clearedEver = ms.filter((m) => m.resolved || (m.relapses ?? 0) > 0).length
  const clearings = clearedEver + relapses // each relapse means it had been cleared once more
  const relapse = shrink(relapses, clearings, PRIOR.relapse, PRIOR.relapseWeight)
  // Pace: how often they're right across graded answers.
  const stats = Object.values(p.topics ?? {}) as TopicStat[]
  const seen = stats.reduce((a, t) => a + t.seen, 0)
  const correct = stats.reduce((a, t) => a + t.correct, 0)
  const pace = shrink(correct, seen, PRIOR.pace, PRIOR.paceWeight)
  // Calibration: when they say they're sure, are they right?
  const sure = (p.calibration ?? []).filter((c) => c.sure === 'sure')
  const sureRight = shrink(sure.filter((c) => c.right).length, sure.length, PRIOR.sureRight, PRIOR.sureWeight)

  const keeps = clamp((PRIOR.relapse - relapse) / PRIOR.relapse)
  const quick = clamp((pace - PRIOR.pace) / (1 - PRIOR.pace))
  const judges = clamp((sureRight - PRIOR.sureRight) / (1 - PRIOR.sureRight))
  // Each part is already pulled toward the default; the whole is also scaled by how much history
  // there is, so a handful of answers (one of them counted in pace and calibration both) can't move
  // the bar: 3 answers ≈ 15 % of the way, 60 answers ≈ 80 %.
  const history = seen + 2 * clearings
  const raw = (0.4 * keeps + 0.35 * quick + 0.25 * judges) * (history / (history + 15))
  // Small differences are noise: treat them as the default.
  const factor = Math.abs(raw) < 0.15 ? 0 : clamp(raw)

  // The reasons, in words: each clear one; when none is clear on its own, the one that weighs most.
  const parts = [
    { v: 0.4 * keeps, up: 'you usually keep what you learn', down: 'some of your fixes have come back before' },
    { v: 0.35 * quick, up: 'you pick things up quickly', down: 'these topics have taken you a few tries' },
    { v: 0.25 * judges, up: 'when you are sure, you are right', down: 'you have been sure of wrong answers before' }
  ]
  const sign = Math.sign(factor)
  const clear = parts.filter((x) => x.v * sign >= 0.3 * 0.25)
  const named = (clear.length ? clear : [...parts].sort((a, b) => b.v * sign - a.v * sign).slice(0, 1)).map((x) => (sign > 0 ? x.up : x.down))
  const why = factor === 0
    ? clearings + seen < 15 ? 'not much history yet, so the standard bar' : 'the standard bar'
    : `${factor > 0 ? 'a lower bar' : 'a higher bar'}: ${named.join('; ')}`
  return { relapse, pace, sureRight, factor, n: { cleared: clearings, answers: seen, sure: sure.length }, why }
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
  const r = 2 - 1.25 * track.factor + 0.5 * depth
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
