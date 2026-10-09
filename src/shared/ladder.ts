import { SKILLS, type AnswerRecord, type Outcome, type Profile, type SkillId, type Sure } from './profile'
import type { GradedMeta } from './memory'

/**
 * The independence ladder: how much of a task the learner decides for themselves. It sits next to
 * an item's difficulty (1–3, how complex the problem is): a hard problem with the part named is still
 * guided. The app works out each item's rung from how it was set up (never the model's say-so), keeps
 * each skill's rung in the profile, moves it with the evidence, and refuses items far below it.
 *
 *   1 guided       the part and the target are given ("use a shunt C to reach r = 1"), or a prediction about one named part
 *   2 one choice   one decision is theirs: the part for a given target, or the value for a given part
 *   3 unguided     a load and a goal; the plan is theirs
 *   4 constrained  the same under limits: a band, a tight VSWR, restricted parts
 *   5 judge        someone else's work: find the mistake
 */
export type Rung = 1 | 2 | 3 | 4 | 5

export const RUNG_NAME: Record<Rung, string> = { 1: 'guided', 2: 'one choice', 3: 'unguided', 4: 'constrained', 5: 'judge' }

/**
 * Skills where the learner builds or decides something. The reading skills (chart basics, Γ/VSWR,
 * admittance) have no plan to hand over; their items keep the difficulty level only.
 */
export const LADDER_SKILLS: SkillId[] = ['lumped_moves', 'l_match', 'tlines', 'stubs', 'q_bandwidth']
export const onLadder = (skill: SkillId) => LADDER_SKILLS.includes(skill)

/**
 * The rungs each skill has items for, so a learner only climbs to steps the tutor can actually set:
 * single moves are predicted (1), done with a part of their choosing (2) or judged in a worked match (5);
 * lines and stubs have no spot-the-mistake items; a band match is constrained by definition.
 */
export const RUNGS_OF: Partial<Record<SkillId, Rung[]>> = {
  lumped_moves: [1, 2, 5],
  l_match: [1, 2, 3, 4, 5],
  tlines: [1, 2, 3, 4],
  stubs: [1, 2, 3, 4],
  q_bandwidth: [1, 2, 4]
}
const rungsOf = (skill: SkillId): Rung[] => RUNGS_OF[skill] ?? [1, 2, 3, 4, 5]
/** The rungs a skill has items for (RUNGS_OF), for code outside the ladder (capstone.ts). */
export const rungsFor = rungsOf
/** The highest rung this skill has at or below r (its lowest if none). */
const snap = (skill: SkillId, r: number): Rung => [...rungsOf(skill)].reverse().find((x) => x <= r) ?? rungsOf(skill)[0]
/** The next rung a streak can reach: judging is earned only by passing a judge item (a jump), never by a streak below it. */
const above = (skill: SkillId, r: Rung): Rung | undefined => rungsOf(skill).find((x) => x > r && x < 5)
const below = (skill: SkillId, r: Rung): Rung => [...rungsOf(skill)].reverse().find((x) => x < r) ?? r
/** Steps apart on this skill's own ladder (positive: the first is higher). */
const stepsApart = (skill: SkillId, a: Rung, b: Rung) => rungsOf(skill).indexOf(snap(skill, a)) - rungsOf(skill).indexOf(snap(skill, b))

export interface LadderState {
  rung: Rung
  /** Clean answers in a row at or above the rung */
  streak: number
  /** Misses in a row at or below the rung (two step it down) */
  misses: number
  /** Answers at this rung since reaching it (how long a climb takes, for the pace) */
  tries: number
  /** An estimate not yet confirmed by an answer at this skill: from related skills or from history */
  provisional?: boolean
  source: 'answers' | 'related' | 'history' | 'start'
  at: string
}

// ── What an item asks of the learner ──────────────────────────────────────

// A connection and a part, either way round: "shunt C", "series inductor", "an inductor in series", "C in shunt".
const PART = '(l|c|inductors?|capacitors?|caps?|inductance|capacitance)'
const CONN = '(series|shunt|parallel)'
const NAMED = new RegExp(`\\b${CONN}[\\s-]+${PART}\\b|\\b${PART}\\d?\\s+in\\s+${CONN}\\b`, 'gi')
/** Words that tell them to use a part (within the same sentence, before it). */
const TO_USE = /\b(add|use|using|put|place|insert|try|wire|connect|fit|with|then|first|start with|followed by)\b/i
const NOT = /\b(don'?t|do not|not|never|no|without|avoid|instead of|rather than)\b[^.]{0,20}$/i

/**
 * The parts the instructions tell the learner to use, which takes that decision from them. Not
 * counted: a choice ("a shunt L or C"), a part they must not use ("don't use a shunt C"), and a part
 * mentioned without being asked for ("your series L got you to g = 1"). Stub types aren't counted
 * either: open or short doesn't give away where the stub goes or how long it is.
 */
export function namedParts(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(NAMED)) {
    const conn = (m[1] ?? m[4]).toLowerCase()
    const part = m[2] ?? m[3]
    const kind = `${conn === 'parallel' ? 'shunt' : conn}${/^c/i.test(part) ? 'C' : 'L'}`
    const sentence = text.slice(0, m.index).split(/[.!?;]\s/).at(-1) ?? ''
    const after = text.slice(m.index! + m[0].length)
    // Alternatives: "shunt L or C", "series inductor or capacitor", "a shunt C or a series L".
    if (/^\s*(,\s*)?or\b/i.test(after) || /\bor\s+(an?\s+)?$/i.test(sentence)) continue
    if (NOT.test(sentence)) continue
    if (!TO_USE.test(sentence)) continue
    found.add(kind)
  }
  return [...found]
}

const LUMPED_KINDS = ['seriesL', 'seriesC', 'shuntL', 'shuntC']

/** A one-step task (reach a target): guided when the part is given, else theirs to choose. */
export function rungOfReach(allowedKinds: string[] | undefined, instructions: string): Rung {
  if ((allowedKinds && allowedKinds.length === 1) || namedParts(instructions).length > 0) return 1
  return 2
}

/**
 * A full match to a VSWR. When the instructions name the parts, or only the solution's two lumped
 * parts are allowed (the card then offers just those), only the values are theirs: one choice.
 * Otherwise the plan is theirs (unguided); a band, a tight VSWR or ruling out one kind of part makes
 * it constrained. Lines and stubs are what a line or stub match is made of, not a restriction.
 */
export function rungOfMatch(allowedKinds: string[] | undefined, maxVswr: number, band: boolean, instructions: string): Rung {
  if (matchIsGuided(allowedKinds, instructions)) return 2
  const lumped = (allowedKinds ?? []).filter((k) => LUMPED_KINDS.includes(k))
  const restricted = lumped.length === 3
  return band || maxVswr <= 1.2 || restricted ? 4 : 3
}

/** The match hands them the parts: named in the instructions, or only two lumped kinds allowed. */
export function matchIsGuided(allowedKinds: string[] | undefined, instructions: string): boolean {
  if (namedParts(instructions).length > 0) return true
  const kinds = allowedKinds ?? []
  return kinds.length > 0 && kinds.length <= 2 && kinds.every((k) => LUMPED_KINDS.includes(k))
}

/** A prediction about a named part: guided; with the reason too, still guided but one step on. */
export const rungOfMove = (withReason: boolean): Rung => (withReason ? 2 : 1)
/** Which part and what value: they choose both, for an amount that is given. */
export const RUNG_COMPONENT: Rung = 2
/** Finding the mistake in a worked match. */
export const RUNG_SPOT: Rung = 5

/** The item's meta with its rung, when its skill is on the ladder. */
export const withRung = (m: GradedMeta, rung: Rung): GradedMeta => (onLadder(m.skill) ? { ...m, rung } : m)

// ── Where a skill stands ───────────────────────────────────────────────────

const fromMastery = (mastery: number): Rung => (mastery < 0.4 ? 1 : mastery < 0.7 ? 2 : 3)

/**
 * Where a skill starts before any answer on it: from the skills it builds on (one rung below the
 * lowest of them on the ladder, as they're related but not the same), or from its mastery
 * (placement test, earlier work), whichever is higher. Provisional until an answer confirms it.
 */
export function startRung(p: Profile, skill: SkillId, at = new Date().toISOString()): LadderState {
  const prereqs = SKILLS.find((s) => s.id === skill)?.prerequisites ?? []
  const known = prereqs.map((s) => p.ladder?.[s]).filter((x): x is LadderState => !!x && !x.provisional)
  const related = known.length ? Math.max(1, Math.min(...known.map((x) => x.rung)) - 1) : 1
  const own = fromMastery(p.skills[skill]?.mastery ?? 0)
  // An estimate never starts past unguided: the constrained and judge steps are earned here.
  const rung = snap(skill, Math.min(3, Math.max(related, own)))
  return { rung, streak: 0, misses: 0, tries: 0, provisional: true, source: known.length && related >= own ? 'related' : 'start', at }
}

export const ladderOf = (p: Profile, skill: SkillId): LadderState => p.ladder?.[skill] ?? startRung(p, skill)

/**
 * How many clean answers in a row take this learner up a rung: from how long their past climbs took
 * (the median, 1–3), on any skill: how fast someone picks things up is about them, not the skill.
 * With too little history, two.
 */
export function climbAfter(p: Profile): number {
  const pace = (p.ladderPace ?? []).slice(-6)
  if (pace.length < 2) return 2
  const sorted = [...pace].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)]
  return Math.min(3, Math.max(1, Math.round(mid)))
}

export interface LadderMove { state: LadderState; pace?: number; note?: string }

/**
 * One graded answer on a ladder item. outcome is after the downgrades (help or a guess makes a right
 * answer partial); fragile = right but unsure.
 *   up:    enough clean answers at the rung (climbAfter), or one step for a clean pass on a harder item
 *   stay:  right but unsure, helped, partly right, a wrong guess, a miss on a stretch
 *   down:  a sure miss at or below the rung, two misses in a row, or a miss on a provisional rung
 */
export function moveOnLadder(p: Profile, m: GradedMeta, outcome: Outcome, sure: Sure | undefined, fragile: boolean, at: string): LadderMove | null {
  if (!m.rung || !onLadder(m.skill)) return null
  const was = ladderOf(p, m.skill)
  const st: LadderState = { ...was, tries: was.tries + 1, at }
  const clean = outcome === 'correct' && !fragile
  const name = (r: Rung) => `rung ${r} (${RUNG_NAME[r]})`
  const rel = stepsApart(m.skill, m.rung, st.rung) // the item against their rung, on this skill's own steps
  // An easy item done well shows nothing new about their rung.
  if (clean && rel < 0) return { state: st }
  if (clean) {
    if (st.provisional) { st.provisional = false; st.source = 'answers' }
    if (rel > 0) {
      // One step up, however hard the item: one clean answer (perhaps a pick from choices) isn't a ladder's worth of proof.
      const to = rungsOf(m.skill)[rungsOf(m.skill).indexOf(snap(m.skill, st.rung)) + 1] ?? st.rung
      return { state: { ...st, rung: to, streak: 0, misses: 0, tries: 0 }, note: `passed a harder item cleanly: ${name(was.rung)} → ${name(to)}` }
    }
    const streak = st.streak + 1
    const up = above(m.skill, st.rung)
    if (streak >= climbAfter(p) && up) {
      return { state: { ...st, rung: up, streak: 0, misses: 0, tries: 0 }, pace: st.tries, note: `up: ${name(was.rung)} → ${name(up)}` }
    }
    return { state: { ...st, streak, misses: 0 } }
  }
  if (outcome === 'incorrect' && rel <= 0) {
    if (sure === 'guess') return { state: { ...st, streak: 0 } }
    const misses = st.misses + 1
    const down = below(m.skill, st.rung)
    // Only an estimate from related skills or the start drops on any miss; a rung rebuilt from their own answers doesn't.
    const guessed = st.provisional && (st.source === 'related' || st.source === 'start')
    if ((sure === 'sure' || misses >= 2 || guessed) && down < st.rung) {
      return { state: { ...st, rung: down, streak: 0, misses: 0, tries: 0, provisional: false, source: 'answers' }, note: `down: ${name(was.rung)} → ${name(down)}` }
    }
    return { state: { ...st, streak: 0, misses } }
  }
  if (outcome === 'incorrect') return { state: st } // a miss on a stretch is expected
  if (fragile) return { state: st } // right but unsure: neither proof nor a miss
  return { state: { ...st, streak: 0 } } // partly right, or right with help
}

// ── Rebuilding rungs from saved answers (learners from before the ladder) ──

/** The rung an old answer most likely had, from what was recorded about it. */
export function rungOfRecord(a: AnswerRecord): Rung | undefined {
  if (a.rung) return a.rung
  if (!onLadder(a.skill)) return undefined
  if (a.ctx?.startsWith('spot the mistake')) return 5
  if (a.topic === 'part_value') return 2
  // Values are reading (wtg, node Q), whatever the skill. Old records may have no format.
  if (a.format === 'value' || a.topic === 'wtg' || a.topic === 'node_q') return undefined
  if (a.format === 'mcq' || a.format === 'click' || a.topic.startsWith('dir_')) return a.difficulty >= 2 && a.topic.startsWith('dir_') ? 2 : 1
  // Tasks: the old records don't say whether the instructions named the parts (in practice they mostly
  // did), so count them low and let new answers raise it: a one-step reach guided, a full match one choice.
  if (a.topic === 'reach_lumped' || a.topic === 'reach_line' || a.topic === 'land_lumped' || a.topic === 'land_line') return 1
  return 2
}

/**
 * Rungs for a profile saved before the ladder: its answers replayed in order. Provisional: the old
 * records don't say how much guidance an item gave, so the first new answers confirm or correct it.
 */
export function rebuildLadder(p: Profile): { ladder: NonNullable<Profile['ladder']>; ladderPace: number[] } {
  // From the start: today's mastery already includes these answers, so it mustn't set where they began.
  const zero = Object.fromEntries(Object.entries(p.skills).map(([k, v]) => [k, { ...v, mastery: 0 }])) as Profile['skills']
  let q: Profile = { ...p, skills: zero, ladder: {}, ladderPace: [] }
  for (const a of p.answers ?? []) {
    const rung = rungOfRecord(a)
    if (!rung) continue
    const helped = !!a.helped || a.sure === 'guess'
    const outcome: Outcome = a.outcome === 'correct' && helped ? 'partial' : a.outcome
    const mv = moveOnLadder(q, { topic: a.topic, skill: a.skill, difficulty: Math.min(3, Math.max(1, a.difficulty)) as 1 | 2 | 3, rung }, outcome, a.sure, outcome === 'correct' && a.sure === 'unsure', a.at)
    if (!mv) continue
    q = { ...q, ladder: { ...q.ladder, [a.skill]: mv.state }, ...(mv.pace !== undefined ? { ladderPace: [...(q.ladderPace ?? []), mv.pace].slice(-12) } : {}) }
  }
  const ladder = Object.fromEntries(Object.entries(q.ladder ?? {}).map(([k, s]) => [k, { ...s!, provisional: true, source: 'history' as const }]))
  return { ladder, ladderPace: q.ladderPace ?? [] }
}

// ── Holding the tutor to it ────────────────────────────────────────────────

export type RungReason = 'warm_up' | 'after_miss' | 'learner_asked'
export const RUNG_REASONS: RungReason[] = ['warm_up', 'after_miss', 'learner_asked']
/** How often each reason may lower an item two or more rungs, per lesson. */
export const REASON_LIMIT: Record<RungReason, number> = { warm_up: 1, after_miss: 3, learner_asked: 2 }

const HOW_TO_RAISE: Record<Rung, string> = {
  1: '',
  2: 'leave the part to them: give the target, not the element (don\'t name it in the instructions or restrict allowed_kinds to one), or ask for a part and its value (ask_component)',
  3: 'give a load and a goal (create_exercise with max_vswr), and don\'t name the parts in the instructions',
  4: 'give a load and a goal with a limit: a band (band_low_hz/band_high_hz), max_vswr ≤ 1.2, or a restricted set of parts; don\'t name which to use',
  5: 'have them judge a worked solution (ask_spot_error)'
}

export interface FitCheck { ok: boolean; message: string; /** The reason that allowed it (counted against the lesson's allowance) */ override?: RungReason }

/**
 * Whether an item suits the learner's rung on its skill, counted in steps on that skill's own rungs.
 * One step below is fine (a warm-up, a confidence check), two for a provisional rung (an estimate);
 * further below is refused unless a reason is given and allowed: a warm-up
 * (once a lesson), right after a miss on this skill, or the learner asked for something easier.
 * Above the rung is allowed: a stretch, and a clean pass jumps them up.
 */
export function checkRung(p: Profile, m: GradedMeta, opts: { reason?: string; used?: Array<{ reason: string }> } = {}): FitCheck {
  if (!m.rung || !onLadder(m.skill)) return { ok: true, message: '' }
  const st = ladderOf(p, m.skill)
  const tag = `${m.skill} ${st.provisional ? 'provisionally ' : ''}at rung ${st.rung} (${RUNG_NAME[st.rung]})`
  const rel = stepsApart(m.skill, m.rung, st.rung)
  if (rel >= 2) return { ok: true, message: ` Independence: this item is rung ${m.rung} (${RUNG_NAME[m.rung]}); they're ${tag}: a stretch, so expect to support them. A clean pass moves them up to it.` }
  // An estimate (from related skills, the placement test or old records) is held more loosely: two below is fine too.
  if (st.provisional && rel === -2) return { ok: true, message: ` Independence: rung ${m.rung} (${RUNG_NAME[m.rung]}); they're ${tag}, an estimate: an answer here confirms or corrects it.` }
  if (rel >= -1) return { ok: true, message: ` Independence: rung ${m.rung} (${RUNG_NAME[m.rung]}); they're ${tag}${rel < 0 ? ': one step below, fine as a warm-up' : rel > 0 ? ': one step above, a stretch' : ''}.` }
  const reason = opts.reason as RungReason | undefined
  if (reason && RUNG_REASONS.includes(reason)) {
    const used = (opts.used ?? []).filter((x) => x.reason === reason).length
    const afterMiss = reason !== 'after_miss' || lastOn(p, m.skill)?.outcome === 'incorrect'
    if (used < REASON_LIMIT[reason] && afterMiss) return { ok: true, override: reason, message: ` Independence: rung ${m.rung} (${RUNG_NAME[m.rung]}), below their rung ${st.rung} (${reason.replace('_', ' ')}: ${REASON_LIMIT[reason] - used - 1} more like this allowed this lesson).` }
    const why = !afterMiss ? 'their last answer on this skill wasn\'t a miss, so after_miss doesn\'t apply' : `already used ${used}× this lesson`
    return { ok: false, message: `Too easy for them (${why}): this item is rung ${m.rung} (${RUNG_NAME[m.rung]}), and they're ${tag}. To pitch it at their rung, ${HOW_TO_RAISE[st.rung]}.` }
  }
  return {
    ok: false,
    message: `Too easy for them: this item is rung ${m.rung} (${RUNG_NAME[m.rung]}), and they're ${tag}. To pitch it at their rung, ${HOW_TO_RAISE[st.rung]}. ` +
      `If there's a reason to go easier, give rung_reason: "warm_up" (once a lesson), "after_miss" (right after they missed one on this skill) or "learner_asked".`
  }
}

export const lastOn = (p: Profile, skill: SkillId) => [...(p.answers ?? [])].reverse().find((a) => a.skill === skill)

// ── Words for the tutor and the learner ────────────────────────────────────

const ASK_AT: Record<Rung, string> = {
  1: 'name the part and the target, or ask which way a named part moves the point',
  2: 'give the target and let them choose the part (or the value for a given part)',
  3: 'give a load and a goal; don\'t name the parts',
  4: 'a load and a goal with a limit: a band, a tight VSWR or restricted parts',
  5: 'have them judge worked solutions (spot the mistake), and give unguided matches'
}

/** One line per ladder skill for the tutor's brief. */
export function ladderBrief(p: Profile, now: string): string {
  const daysSince = (iso?: string) => (iso ? (Date.parse(now) - Date.parse(iso)) / 86_400_000 : Infinity)
  const lines = LADDER_SKILLS.map((s) => {
    const st = ladderOf(p, s)
    const away = daysSince(p.skills[s]?.lastPracticed) >= 7 && p.ladder?.[s] ? '; back after a break: a warm-up one rung lower is fine' : ''
    return `- ${s}: rung ${st.rung} ${RUNG_NAME[st.rung]}${st.provisional ? ' (provisional)' : ''}: ${ASK_AT[st.rung]}${away}`
  })
  return `Independence ladder (how much they decide; app-enforced: items 2+ steps below are refused, 3+ for a provisional rung, i.e. an estimate the first answer confirms):\n${lines.join('\n')}`
}

/** What they're working at now (not a claim they've mastered it): the tutor pitches tasks here. */
const LEARNER_WORDS: Record<Rung, string> = {
  1: 'guided steps (the part and target are given)',
  2: 'choosing the part yourself',
  3: 'planning whole matches yourself',
  4: 'matching under limits (bands, tight targets, fewer parts)',
  5: 'checking worked solutions for mistakes'
}

/** What a rung means to the learner ("choosing the part yourself"). */
export const rungWords = (r: Rung) => LEARNER_WORDS[r]

/** For the Progress page: where they are on a skill and the next step up. */
export function ladderLine(p: Profile, skill: SkillId): { now: string; next?: string; provisional: boolean } | null {
  if (!onLadder(skill)) return null
  const st = p.ladder?.[skill]
  if (!st) return null
  const next = rungsOf(skill).find((x) => x > st.rung)
  return { now: LEARNER_WORDS[st.rung], next: next ? LEARNER_WORDS[next] : undefined, provisional: !!st.provisional }
}
