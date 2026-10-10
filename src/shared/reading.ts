import { SKILLS, type Outcome, type Profile, type SkillId, type Sure } from './profile'
import { climbAfter, lastOn, onLadder, REASON_LIMIT, RUNG_REASONS, type RungReason } from './ladder'

/**
 * Reading questions (a value at a point, a spot to click) are answered on a chart that also prints
 * the numbers: the readout card, the hover tip, the results table. Copying a number shows the learner
 * knows where the app keeps it, not that they can read the chart. So while a reading question is open
 * the app covers those numbers, and only an answer read from the chart counts in full.
 *
 * Each skill with reading questions has two steps, kept by the app like the independence ladder:
 *   readout  values shown: they learn what the number is and where it lives (answers count partly)
 *   chart    values covered: they read it from the chart (answers count fully)
 * A beginner starts on the readout and moves to the chart after a few right answers (their pace);
 * a clean answer from the chart moves them there at once. Sure misses, two misses, or uncovering
 * the values twice in a row take them back to the readout.
 */
export type ReadStage = 'readout' | 'chart'

export interface ReadingState {
  stage: ReadStage
  /** Right answers in a row at this stage */
  streak: number
  /** Misses (or uncoverings) in a row from the chart: two take them back to the readout */
  misses: number
  /** An estimate (from mastery or a related skill) not yet confirmed by an answer here */
  provisional?: boolean
  source: 'answers' | 'related' | 'start'
  at: string
}

/**
 * How the values stood when they answered: covered, shown by the tutor, or uncovered by the learner.
 * typed: a click question answered by typing the point (the keyboard way in), which copies the
 * question's own z rather than finding it on the chart.
 */
export type ValuesSeen = 'covered' | 'shown' | 'revealed' | 'typed'

/** Values on screen (or the point typed in) when they answered: the answer counts as partly theirs. */
export const readOff = (v: ValuesSeen | undefined) => v === 'shown' || v === 'revealed' || v === 'typed'

/**
 * Where a skill starts: on the chart if they already know it well enough (mastery from the placement
 * test or earlier work) or read the chart unaided in chart basics or a skill this one builds on (the
 * same act of reading the grid); otherwise on the readout. An estimate until an answer confirms it.
 */
export function readingStart(p: Profile, skill: SkillId, at = new Date().toISOString()): ReadingState {
  const prereqs = SKILLS.find((s) => s.id === skill)?.prerequisites ?? []
  const related = [...new Set(['chart_basics' as SkillId, ...prereqs])].filter((s) => s !== skill)
    .some((s) => p.reading?.[s]?.stage === 'chart' && !p.reading[s]!.provisional)
  const own = (p.skills[skill]?.mastery ?? 0) >= 0.4
  return { stage: own || related ? 'chart' : 'readout', streak: 0, misses: 0, provisional: true, source: !own && related ? 'related' : 'start', at }
}

/**
 * The saved stage, or an estimate. An estimate no answer has confirmed yet is worked out again each
 * time, so it follows their mastery and related skills as those grow (keeping its streak while the
 * stage is the same).
 */
export function readingOf(p: Profile, skill: SkillId): ReadingState {
  const saved = p.reading?.[skill]
  if (saved && !(saved.provisional && saved.source !== 'answers')) return saved
  const est = readingStart(p, skill, saved?.at)
  return saved && saved.stage === est.stage ? { ...saved, source: est.source } : est
}

export interface ReadingMove { state: ReadingState; note?: string }

/**
 * One graded reading answer, from the raw result (before any downgrade): right or not, how sure they
 * said they were, and whether they had help from the tutor. Clean = right, on their own, and sure.
 */
export function moveReading(p: Profile, skill: SkillId, values: ValuesSeen, outcome: Outcome, how: { sure?: Sure; helped?: boolean }, at: string): ReadingMove {
  const was = readingOf(p, skill)
  const st: ReadingState = { ...was, at }
  const { sure, helped } = how
  const clean = outcome === 'correct' && !helped && sure !== 'guess' && sure !== 'unsure'
  // Typing the point given in the question shows nothing about reading the chart, either way.
  if (values === 'typed') return { state: st }
  const toChart = (note: string): ReadingMove => ({ state: { ...st, stage: 'chart', streak: 0, misses: 0, provisional: false, source: 'answers' }, note })
  const toReadout = (note: string): ReadingMove => ({ state: { ...st, stage: 'readout', streak: 0, misses: 0, provisional: false, source: 'answers' }, note })
  // Right but unsure (on their own, not a guess) is half the proof of a sure answer: two of them count as
  // one. A learner who always says "not sure" but is right still moves (the Riya re-run never did).
  const half = outcome === 'correct' && !helped && sure === 'unsure'
  if (values === 'covered') {
    if (clean) {
      if (st.stage === 'readout') return toChart('read it from the chart cleanly: values stay covered from now on')
      return { state: { ...st, streak: st.streak + 1, misses: 0, provisional: false, source: 'answers' } }
    }
    if (half) {
      const streak = st.streak + 0.5
      if (streak < 1) return { state: { ...st, streak, misses: 0 } }
      if (st.stage === 'readout') return toChart('read it from the chart twice, unsure but right: values stay covered from now on')
      return { state: { ...st, streak, misses: 0, provisional: false, source: 'answers' } }
    }
    if (outcome === 'incorrect' && st.stage === 'chart') {
      if (sure === 'guess') return { state: { ...st, streak: 0 } }
      const misses = st.misses + 1
      const guessed = st.provisional && st.source !== 'answers'
      if (sure === 'sure' || misses >= 2 || guessed) return toReadout('missed reading it from the chart: values shown again for a while')
      return { state: { ...st, streak: 0, misses } }
    }
    // Right but unsure, helped or a guess: no proof, but not a miss either (misses are counted in a row).
    if (outcome === 'correct') return { state: { ...st, streak: 0, misses: 0 } }
    return { state: { ...st, streak: 0 } } // a miss while still on the readout
  }
  if (values === 'revealed' && st.stage === 'chart') {
    // They uncovered the values: they couldn't read it from the chart, whatever they answered.
    const misses = st.misses + 1
    if (misses >= 2) return toReadout('uncovered the values twice in a row: values shown again for a while')
    return { state: { ...st, streak: 0, misses } }
  }
  if (st.stage === 'readout') {
    // Right with the values on screen, on their own and sure: they know what the number is and where it lives (unsure: half).
    if (!clean && !half) return { state: { ...st, streak: 0 } }
    const streak = st.streak + (clean ? 1 : 0.5)
    if (streak >= climbAfter(p)) return toChart('found it on the readout reliably: values covered from the next question')
    // One half isn't proof yet: the estimate stays an estimate (and follows their mastery) until a full step.
    return { state: { ...st, streak, ...(streak >= 1 ? { provisional: false, source: 'answers' as const } : {}) } }
  }
  return { state: st } // shown by the tutor at the chart stage (a warm-up): shows nothing about reading
}

export interface ValuesCheck { ok: boolean; values: 'covered' | 'shown'; message: string; override?: RungReason }

/**
 * Whether the values are covered for a new reading question. On the readout stage they're shown
 * unless the tutor asks to cover them (a stretch). On the chart stage they're covered; showing them
 * needs a reason, counted against the same per-lesson allowance as the ladder's.
 */
export function checkValues(p: Profile, skill: SkillId, want: 'covered' | 'shown' | undefined, opts: { reason?: string; used?: Array<{ reason: string }> } = {}): ValuesCheck {
  const st = readingOf(p, skill)
  const est = st.provisional ? ' (an estimate)' : ''
  if (st.stage === 'readout') {
    if (want === 'covered') return { ok: true, values: 'covered', message: ` Values covered: a stretch, as they still read ${skill} off the readout${est}; a clean answer moves them to the chart.` }
    return { ok: true, values: 'shown', message: ` Values shown: they're at the readout stage on ${skill}${est}, so the answer counts partly; a few right ones and the app covers the values.` }
  }
  if (want !== 'shown') return { ok: true, values: 'covered', message: ' Values covered on their screen (readout, hover tip, tables) until they answer: they read it from the chart. Don\'t read the number out to them. They can uncover it, but then it counts partly.' }
  const reason = opts.reason as RungReason | undefined
  if (reason && RUNG_REASONS.includes(reason)) {
    const used = (opts.used ?? []).filter((x) => x.reason === reason).length
    const afterMiss = reason !== 'after_miss' || lastOn(p, skill)?.outcome === 'incorrect'
    if (used < REASON_LIMIT[reason] && afterMiss) return { ok: true, values: 'shown', override: reason, message: ` Values shown (${reason.replace('_', ' ')}): the answer counts partly.` }
    const why = !afterMiss ? 'their last answer on this skill wasn\'t a miss, so after_miss doesn\'t apply' : `already used ${used}× this lesson`
    return { ok: false, values: 'covered', message: `Can't show the values (${why}): they read ${skill} from the chart${est}. Leave values out (the app covers them).` }
  }
  return {
    ok: false, values: 'covered',
    message: `They read ${skill} from the chart${est}, so the app covers the values. Leave values out, or give rung_reason: "warm_up" (once a lesson), "after_miss" (right after a miss on this skill) or "learner_asked".`
  }
}

/** Skills whose Progress row shows the reading step (the others show their ladder rung). */
export const READING_SKILLS: SkillId[] = ['chart_basics', 'reflection', 'admittance']

/** One line for the tutor's brief: which skills read from the chart and which off the readout. */
export function readingBrief(p: Profile): string {
  const at = (stage: ReadStage) => (['chart_basics', 'reflection', 'admittance', 'tlines', 'q_bandwidth'] as SkillId[])
    .filter((s) => readingOf(p, s).stage === stage).map((s) => `${s}${readingOf(p, s).provisional ? '?' : ''}`).join(', ') || 'none'
  return `Reading questions (ask_value, ask_locate of a point; app-set, ? = estimate): from the chart, values covered: ${at('chart')}; off the readout, values shown: ${at('readout')}.`
}

/** For the Progress page. */
export function readingLine(p: Profile, skill: SkillId): { now: string; next?: string; provisional: boolean } | null {
  if (!READING_SKILLS.includes(skill) || onLadder(skill)) return null
  const st = readingOf(p, skill)
  return st.stage === 'chart'
    ? { now: 'reading values from the chart yourself', provisional: !!st.provisional }
    : { now: 'reading values off the readout', next: 'reading them from the chart, with the readout covered', provisional: !!st.provisional }
}
