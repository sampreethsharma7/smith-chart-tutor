/**
 * The tutor's memory of a learner, kept by the app so it is the same whichever model
 * teaches. Graded answers update it exactly; the tutor adds judgement (notes,
 * misconceptions it spots in conversation). Everything here is small on purpose:
 * per-topic statistics instead of raw answers, a few categorised notes, and a
 * bounded brief that is what the tutor actually reads when planning.
 */
import { ANSWER_LOG_MAX, applyEvidence, lessonsOf, SKILLS, type Misconception, type Outcome, type Profile, type SkillId, type Sure } from './profile'
import { gatherEvidence, sessionAt, signOff, SIGNOFF_WORDS, trackOf, type SignOff } from './signoff'

// ── Topics: the specific things a learner can be good or shaky at ───────────

export const TOPICS = [
  { id: 'plot_z', skill: 'chart_basics', name: 'placing an impedance (z) on the chart' },
  { id: 'read_z', skill: 'chart_basics', name: 'reading z and Z off the chart' },
  { id: 'gamma_vswr', skill: 'reflection', name: '|Γ|, VSWR and return loss' },
  { id: 'gamma_angle', skill: 'reflection', name: 'the angle of Γ' },
  { id: 'plot_y', skill: 'admittance', name: 'placing an admittance (y)' },
  { id: 'read_y', skill: 'admittance', name: 'reading y and Y' },
  { id: 'dir_seriesL', skill: 'lumped_moves', name: 'which way a series L moves the point' },
  { id: 'dir_seriesC', skill: 'lumped_moves', name: 'which way a series C moves the point' },
  { id: 'dir_shuntL', skill: 'lumped_moves', name: 'which way a shunt L moves the point' },
  { id: 'dir_shuntC', skill: 'lumped_moves', name: 'which way a shunt C moves the point' },
  { id: 'land_lumped', skill: 'lumped_moves', name: 'where an L or C lands the point' },
  { id: 'reach_lumped', skill: 'lumped_moves', name: 'moving onto a target with L and C' },
  { id: 'l_match', skill: 'l_match', name: 'two-element L-matching' },
  { id: 'l_match_tight', skill: 'l_match', name: 'tight or restricted L-matches' },
  { id: 'part_value', skill: 'l_match', name: 'turning x or b into an L or C value' },
  { id: 'dir_line', skill: 'tlines', name: 'which way a line turns the point' },
  { id: 'land_line', skill: 'tlines', name: 'where a line takes the point' },
  { id: 'reach_line', skill: 'tlines', name: 'moving or matching with lines' },
  { id: 'wtg', skill: 'tlines', name: 'wavelengths toward generator' },
  { id: 'stub_match', skill: 'stubs', name: 'stubs' },
  { id: 'band_match', skill: 'q_bandwidth', name: 'matching across a band' },
  { id: 'node_q', skill: 'q_bandwidth', name: 'node Q' }
] as const satisfies ReadonlyArray<{ id: string; skill: SkillId; name: string }>

export type TopicId = (typeof TOPICS)[number]['id']
export const TOPIC_IDS = TOPICS.map((t) => t.id) as TopicId[]
export const topicDef = (id: string) => TOPICS.find((t) => t.id === id)

export type Difficulty = 1 | 2 | 3

/**
 * What a graded item practises and how hard it is, worked out by the app (never guessed
 * by the model). ctx: the situation it was asked in (e.g. "upper half"), so a topic only
 * counts as solid once it has been right in more than one.
 */
export interface GradedMeta { topic: TopicId; skill: SkillId; difficulty: Difficulty; ctx?: string }

/** How the answer was given: a pick from choices proves less than a click, a value or a task. */
export type AnswerFormat = 'mcq' | 'click' | 'value' | 'task'

/**
 * How much one answer proves (0–1). A right pick from k choices is discounted by the
 * chance of guessing it (1/k); everything else, and every wrong answer, counts fully.
 */
export function evidenceWeight(format: AnswerFormat | undefined, choices: number | undefined, outcome: Outcome): number {
  if (outcome !== 'correct' || format !== 'mcq') return 1
  return 1 - 1 / Math.max(2, choices ?? 3)
}

const meta = (topic: TopicId, difficulty: Difficulty): GradedMeta => ({ topic, skill: topicDef(topic)!.skill, difficulty })

type Kind = 'seriesL' | 'seriesC' | 'seriesR' | 'shuntL' | 'shuntC' | 'shuntR' | 'tline' | 'openStub' | 'shortStub'
const isStub = (k: string) => k.endsWith('Stub')
const LUMPED = ['seriesL', 'seriesC', 'shuntL', 'shuntC']

/** withReason: they must also pick why (two-part), one level harder than the direction alone. */
export function classifyMove(kind: Kind, ask: 'path' | 'end_half', withReason = false): GradedMeta {
  const up = (d: Difficulty) => Math.min(3, d + (withReason && ask === 'path' ? 1 : 0)) as Difficulty
  if (kind === 'tline') return meta(ask === 'end_half' ? 'land_line' : 'dir_line', up(2))
  if (isStub(kind)) return meta('stub_match', up(2))
  if (ask === 'end_half') return meta('land_lumped', 2)
  const dir = `dir_${kind}` as TopicId
  return meta(TOPIC_IDS.includes(dir) ? dir : 'land_lumped', up(1))
}

/** The same item in a given situation (see regionOf): a topic is solid only once right in two. */
export const inSituation = (m: GradedMeta, ctx: string): GradedMeta => ({ ...m, ctx })

/** A spot to click: a plain z (easy on a major grid line), a y, or where an element lands. */
export function classifyLocate(via: 'z' | 'y' | Kind, onMajorGrid = false): GradedMeta {
  if (via === 'z') return meta('plot_z', onMajorGrid ? 1 : 2)
  if (via === 'y') return meta('plot_y', 2)
  if (via === 'tline') return meta('land_line', 3)
  if (isStub(via)) return meta('stub_match', 3)
  return meta('land_lumped', 2)
}

export function classifyValue(quantity: string): GradedMeta {
  switch (quantity) {
    case 'vswr': case 'gamma_mag': return meta('gamma_vswr', 1)
    case 'return_loss_db': return meta('gamma_vswr', 2)
    case 'gamma_angle_deg': return meta('gamma_angle', 2)
    case 'z': return meta('read_z', 1)
    case 'Z_ohm': return meta('read_z', 2)
    case 'y': return meta('read_y', 2)
    case 'Y_mS': return meta('read_y', 3)
    case 'q': return meta('node_q', 2)
    default: return meta('wtg', 2)
  }
}

export function classifyReach(kinds: string[], toAdd: number, pointTarget: boolean): GradedMeta {
  const lines = kinds.some((k) => k === 'tline' || isStub(k))
  const topic: TopicId = kinds.some(isStub) ? 'stub_match' : lines && !kinds.some((k) => LUMPED.includes(k)) ? 'reach_line' : 'reach_lumped'
  return meta(topic, toAdd >= 2 || pointTarget ? 3 : 2)
}

export function classifyMatch(kinds: string[], maxVswr: number, band: boolean): GradedMeta {
  if (band) return meta('band_match', 3)
  if (kinds.some(isStub)) return meta('stub_match', 3)
  if (kinds.length && kinds.every((k) => k === 'tline')) return meta('reach_line', 3)
  const restricted = kinds.length > 0 && kinds.filter((k) => LUMPED.includes(k)).length < 4
  return maxVswr <= 1.2 || restricted ? meta('l_match_tight', 3) : meta('l_match', 2)
}

/**
 * The topic a misconception is about, from its wording, for ones recorded without one
 * (older profiles, or the tutor not giving it). Only clear cases; otherwise undefined.
 */
export function inferTopic(m: Pick<Misconception, 'description' | 'skill' | 'topic'>): TopicId | undefined {
  if (m.topic) return m.topic
  const d = m.description.toLowerCase()
  const el = /\b(series|shunt|parallel)\s+(l|c|inductors?|capacitors?)\b/.exec(d)
  if (el && /clockwise/.test(d)) {
    const kind = `${el[1] === 'series' ? 'series' : 'shunt'}${el[2].startsWith('c') ? 'C' : 'L'}`
    return `dir_${kind}` as TopicId
  }
  if (/\b(line|toward(s)? the (generator|load)|λ|wavelength)/.test(d) && /clockwise|rotat/.test(d)) return 'dir_line'
  if (/γ|gamma|vswr|return loss|reflection/.test(d)) return /angle|∠/.test(d) ? 'gamma_angle' : 'gamma_vswr'
  if (/\b(admittance|susceptance|y =|conductance)/.test(d)) return 'read_y'
  return undefined
}

// ── Per-topic statistics, the level to aim at next, and spaced review ───────

export interface TopicStat {
  seen: number
  correct: number
  /** Last results, newest last: 1 right, 0.5 partly, 0 wrong */
  recent: number[]
  /** Right answers in a row at or above the aim level */
  streak: number
  /** Difficulty to pitch the next item at (1–3) */
  level: Difficulty
  /** Spaced-review box (0–5); due = when to come back to it */
  box: number
  due: string
  lastSeen: string
  /**
   * Their right answers (unaided and not hedged), newest last: in which lesson, at what
   * difficulty, in what context. Proof that a skill is strong, and closes misconceptions.
   */
  rightIn: Array<{ session: string; at: string; d?: number; ctx?: string; sure?: boolean }>
}

/** Days until a topic is due again, by box: wrong answers come back tomorrow, solid ones a month later. */
export const REVIEW_DAYS = [0, 1, 3, 7, 14, 30]

const DAY = 86_400_000
const addDays = (iso: string, d: number) => new Date(new Date(iso).getTime() + d * DAY).toISOString()

/** Where an unseen topic starts: from the skill's mastery (placement test, earlier work). */
export function startLevel(p: Profile, topic: TopicId): Difficulty {
  const m = p.skills[topicDef(topic)!.skill]?.mastery ?? 0
  return m < 0.4 ? 1 : m < 0.7 ? 2 : 3
}

export const aimFor = (p: Profile, topic: TopicId): Difficulty => p.topics?.[topic]?.level ?? startLevel(p, topic)

/**
 * fragile: right but not sure of it. It counts as right, but doesn't move the level up,
 * isn't proof, and comes back for review a little sooner (one box back).
 */
function updateTopic(p: Profile, m: GradedMeta, outcome: Outcome, session: string, at: string, fragile = false, sure = false): TopicStat {
  const t: TopicStat = p.topics?.[m.topic] ?? { seen: 0, correct: 0, recent: [], streak: 0, level: startLevel(p, m.topic), box: 0, due: at, lastSeen: at, rightIn: [] }
  const score = outcome === 'correct' ? 1 : outcome === 'partial' ? 0.5 : 0
  let { level, streak, box } = t
  if (outcome === 'correct' && fragile) {
    box = Math.max(0, box - 1)
  } else if (outcome === 'correct') {
    // Easy items (below the aim) don't move the level: only work at the edge counts.
    if (m.difficulty >= level) streak++
    if (streak >= 2 && level < 3) { level = (level + 1) as Difficulty; streak = 0 }
    box = Math.min(5, box + 1)
  } else if (outcome === 'incorrect') {
    // A miss on something harder than the aim is expected; a miss at or below it means step down.
    if (m.difficulty <= level && level > 1) level = (level - 1) as Difficulty
    streak = 0
    box = 1
  } else streak = 0
  return {
    seen: t.seen + 1,
    correct: t.correct + (outcome === 'correct' ? 1 : 0),
    recent: [...t.recent, score].slice(-8),
    streak,
    level,
    box,
    due: addDays(at, REVIEW_DAYS[box]),
    lastSeen: at,
    rightIn: outcome === 'correct' && !fragile ? [...(t.rightIn ?? []), { session, at, d: m.difficulty, ...(m.ctx ? { ctx: m.ctx } : {}), ...(sure ? { sure } : {}) }].slice(-8) : t.rightIn
  }
}

// ── Recording a graded result ───────────────────────────────────────────────

export interface GradedResult {
  meta: GradedMeta
  outcome: Outcome
  /** Short label, e.g. "Which way does a shunt C move the load?" */
  label: string
  session: string
  at: string
  /** A specific wrong idea shown by a wrong answer, recorded against the topic */
  misconception?: string
  /** How it was answered, and how many choices there were (for the guessing discount) */
  format?: AnswerFormat
  choices?: number
  /** They had help (talked it through with the tutor while it was open, or needed several checks) */
  helped?: boolean
  /** How sure they said they were, before seeing the result */
  sure?: Sure
}

/** What each answer told us about how well they judge themselves, put together. */
export interface Calibration {
  sure: { n: number; right: number }
  unsure: { n: number; right: number }
  guess: { n: number; right: number }
  /**
   * under: right most of the time even when unsure (trust yourself more);
   * over: often wrong when sure (slow down and check); fair; or unknown (too few answers).
   */
  verdict: 'under' | 'over' | 'fair' | 'unknown'
}

export function calibrationOf(p: Profile): Calibration {
  const log = (p.calibration ?? []).slice(-40)
  const of = (s: Sure) => ({ n: log.filter((x) => x.sure === s).length, right: log.filter((x) => x.sure === s && x.right).length })
  const c = { sure: of('sure'), unsure: of('unsure'), guess: of('guess') }
  const rate = (x: { n: number; right: number }) => (x.n ? x.right / x.n : NaN)
  const verdict: Calibration['verdict'] =
    log.length < 5 ? 'unknown'
    : c.sure.n >= 3 && rate(c.sure) < 0.7 ? 'over'
    : c.unsure.n + c.guess.n >= 3 && (c.unsure.right + c.guess.right) / (c.unsure.n + c.guess.n) >= 0.75 ? 'under'
    : 'fair'
  return { ...c, verdict }
}

/**
 * Where a misconception stands (signoff.ts): the evidence on its topic since it was last seen, from
 * later lessons only, judged against what this learner needs for a mistake this deep. recordFrom:
 * the profile to judge their record from (the one before an answer being recorded, so an answer
 * doesn't lower its own bar).
 */
export function misconceptionSignOff(p: Profile, x: Misconception, recordFrom: Profile = p): SignOff {
  const topic = inferTopic(x)
  const track = trackOf(recordFrom)
  const last = x.sessions?.length ? x.sessions : [sessionAt(p, x.lastSeen)].filter((s): s is string => !!s)
  const evidence = gatherEvidence(p, {
    topics: topic ? [topic] : [], after: x.lastSeen, exclude: new Set(last),
    seenCtx: new Set(x.ctxs ?? []), misconception: x.id
  })
  return signOff(evidence, track, { count: x.count, lessons: Math.max(1, x.sessions?.length ?? 1), relapses: x.relapses ?? 0, confident: x.confident })
}

/** Add a lesson / situation to where a misconception was seen (bounded). */
const seenIn = (list: string[] | undefined, v: string | undefined) => (v && !list?.includes(v) ? [...(list ?? []), v].slice(-8) : list)

/**
 * Apply one graded result: skill mastery (exact rule), the topic's level and review
 * date, and misconceptions on that topic: cleared when the adaptive sign-off says so
 * (signoff.ts: never in the lesson it appeared, the bar set by this learner's record),
 * reopened on a slip with a higher bar. Returns the new profile and a short report for the tutor.
 */
export function recordGraded(p: Profile, r: GradedResult): { profile: Profile; report: string } {
  const { meta: m, at } = r
  // Right with help shows they can follow, not that they can do it alone; right by a guess shows
  // little: both partly right. Right but unsure: right, but fragile (weighs less, comes back soon).
  const outcome: Outcome = r.outcome === 'correct' && (r.helped || r.sure === 'guess') ? 'partial' : r.outcome
  const fragile = outcome === 'correct' && r.sure === 'unsure'
  const weight = evidenceWeight(r.format, r.choices, r.outcome) * (fragile ? 0.6 : 1)
  const before = p.skills[m.skill]
  const skill = applyEvidence(before, outcome, m.difficulty, `app: ${r.label.slice(0, 60)}`, { weight, floor: r.outcome === 'correct' })
  const topic = updateTopic(p, m, outcome, r.session, at, fragile, r.sure === 'sure')
  const notes: string[] = []
  let misconceptions = p.misconceptions
  const onTopic = (x: Misconception) => inferTopic(x) === m.topic

  if (outcome === 'correct') {
    const withAnswer: Profile = { ...p, topics: { ...(p.topics ?? {}), [m.topic]: topic } }
    misconceptions = misconceptions.map((x) => {
      if (!onTopic(x)) return x
      const so = misconceptionSignOff(withAnswer, x, p)
      const sameLesson = (x.sessions ?? []).includes(r.session) || (!x.sessions && sessionAt(p, x.lastSeen) === r.session)
      if (x.resolved) {
        if (so.status === 'confirmed' && !sameLesson) notes.push(`misconception confirmed gone: "${x.description}" (it held in a later lesson)`)
        return x
      }
      if (sameLesson) {
        notes.push(`misconception "${x.description}": this answer doesn't count toward clearing it (same lesson it appeared in: shows they followed, not that it's fixed)`)
        return x
      }
      if (so.status === 'cleared' || so.status === 'confirmed') {
        notes.push(`misconception cleared, provisionally: "${x.description}" (evidence ${so.points} of ${so.required}; ${so.why}). Tell them it's cleared and you'll check it again in a later lesson; don't call it fixed`)
        return { ...x, topic: m.topic, resolved: true, resolvedAt: at }
      }
      notes.push(`misconception "${x.description}": looking better (evidence ${so.points} of ${so.required}; ${so.why}); still needs ${so.needed}. Say it's looking better, not fixed`)
      return x
    })
  } else if ((outcome === 'incorrect' || (outcome === 'partial' && r.misconception)) && r.sure !== 'guess') {
    // A wrong guess is a gap, not a mental model; a wrong answer they were sure of is the real thing.
    // Partly right with a named wrong idea (the right answer for the wrong reason) counts too.
    const confident = r.sure === 'sure'
    const existing = misconceptions.find(onTopic)
    if (existing) {
      if (existing.resolved) notes.push(`misconception back: "${existing.description}" (it had been cleared: the bar to clear it again is higher)`)
      misconceptions = misconceptions.map((x) => (x === existing
        // Keep the existing wording (often the tutor's, and better than a generated one); just count it.
        ? {
            ...x, topic: m.topic, count: x.count + 1, lastSeen: at, resolved: false, resolvedAt: undefined,
            sessions: seenIn(x.sessions, r.session), ctxs: seenIn(x.ctxs, m.ctx),
            ...(x.resolved ? { relapses: (x.relapses ?? 0) + 1 } : {}),
            ...(confident ? { confident: true } : {})
          }
        : x))
    } else if (r.misconception || confident) {
      const description = r.misconception ?? `Sure of a wrong answer on ${topicDef(m.topic)!.name}`
      misconceptions = [...misconceptions, { id: `mc_${new Date(at).getTime().toString(36)}`, skill: m.skill, topic: m.topic, description, count: 1, firstSeen: at, lastSeen: at, resolved: false, sessions: [r.session], ...(m.ctx ? { ctxs: [m.ctx] } : {}), ...(confident ? { confident: true } : {}) }]
      notes.push(`misconception noted: "${description}"`)
    }
    if (confident) notes.push('they were SURE of this wrong answer: a real misconception, worth undoing before moving on')
  }
  if (r.sure === 'guess' && r.outcome === 'correct') notes.push('right, but they said they were guessing: counted as partly right')
  // Find the edges fast: after a clean right answer at the aim, one harder; after a miss, one easier.
  const clean = outcome === 'correct' && !fragile
  if (clean && m.difficulty >= (p.topics?.[m.topic]?.level ?? startLevel(p, m.topic)) && m.difficulty < 3) {
    notes.push(`probe up: next time on this topic, ask at level ${m.difficulty + 1} to find their ceiling`)
  } else if (outcome === 'incorrect' && m.difficulty > 1) {
    notes.push(`probe down: ask this topic at level ${m.difficulty - 1} to find what they do know`)
  }
  const situations = new Set(topic.rightIn.map((e) => e.ctx ?? ''))
  if (clean && situations.size < 2) notes.push(`all their right answers on this topic are in one situation${m.ctx ? ` (${m.ctx})` : ''}: next time change it (other half of the chart, other side of r = 1, other quantity)`)
  if (fragile) notes.push('right, but they weren\'t sure: it comes back for review soon and isn\'t proof yet')

  const profile: Profile = {
    ...p,
    skills: { ...p.skills, [m.skill]: skill },
    topics: { ...(p.topics ?? {}), [m.topic]: topic },
    misconceptions,
    ...(r.sure ? { calibration: [...(p.calibration ?? []), { sure: r.sure, right: r.outcome === 'correct', at, topic: m.topic }].slice(-80) } : {}),
    answers: [...(p.answers ?? []), {
      at, session: r.session, topic: m.topic, skill: m.skill, difficulty: m.difficulty, outcome: r.outcome,
      ...(r.sure ? { sure: r.sure } : {}), ...(r.helped ? { helped: true } : {}), ...(r.format ? { format: r.format } : {}), ...(m.ctx ? { ctx: m.ctx } : {})
    }].slice(-ANSWER_LOG_MAX)
  }
  const name = topicDef(m.topic)!.name
  const levelMove = topic.level > (p.topics?.[m.topic]?.level ?? startLevel(p, m.topic)) ? ' (up)' : topic.level < (p.topics?.[m.topic]?.level ?? startLevel(p, m.topic)) ? ' (down)' : ''
  if (r.outcome === 'correct' && r.helped) notes.push('counted as partly right: they had help')
  else if (weight < 1) notes.push(`a pick from ${r.choices ?? 3} choices, so it counts ${Math.round(weight * 100)}% (could be a guess)`)
  const report = `Recorded automatically (don't record_evidence for this answer): ${m.skill} ${before.mastery.toFixed(2)} → ${skill.mastery.toFixed(2)}; ${name}: ${topic.correct} of ${topic.seen} right, next aim level ${topic.level}${levelMove}, review again in ${REVIEW_DAYS[topic.box]} day(s)${notes.length ? `; ${notes.join('; ')}` : ''}.`
  return { profile, report }
}

// ── What was asked recently (so it isn't repeated) ──────────────────────────

export interface AskedItem { at: string; topic: TopicId; difficulty: Difficulty; kind: string; text: string }

export const noteAsked = (p: Profile, item: AskedItem): Profile => ({ ...p, asked: [...(p.asked ?? []), { ...item, text: item.text.slice(0, 90) }].slice(-20) })

// ── Notes: a few, categorised, kept current ─────────────────────────────────

export const NOTE_CATEGORIES = ['goal', 'preference', 'clicked', 'struggle', 'other'] as const
export type NoteCategory = (typeof NOTE_CATEGORIES)[number]
export interface Note { id: string; category: NoteCategory; text: string; at: string }

/** At most this many notes per category: the oldest goes when a new one comes. */
export const NOTES_PER_CATEGORY = 5

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Save a note. With `replaces` it updates that note; a near-duplicate in the same
 * category is replaced rather than added twice.
 */
export function saveNote(p: Profile, n: { category: NoteCategory; text: string; replaces?: string }, at: string): { profile: Profile; id: string; replaced?: string } {
  const notes = p.notes ?? []
  const key = norm(n.text)
  const dup = notes.find((x) => x.id === n.replaces) ??
    notes.find((x) => x.category === n.category && (norm(x.text) === key || norm(x.text).includes(key) || key.includes(norm(x.text))))
  const id = dup?.id ?? `n_${new Date(at).getTime().toString(36)}${notes.length}`
  const note: Note = { id, category: n.category, text: n.text.trim().slice(0, 240), at }
  let next = dup ? notes.map((x) => (x.id === dup.id ? note : x)) : [...notes, note]
  const inCat = next.filter((x) => x.category === n.category)
  if (inCat.length > NOTES_PER_CATEGORY) {
    const drop = new Set(inCat.slice(0, inCat.length - NOTES_PER_CATEGORY).map((x) => x.id))
    next = next.filter((x) => !drop.has(x.id))
  }
  return { profile: { ...p, notes: next }, id, replaced: dup?.id }
}

export const forgetNote = (p: Profile, id: string): Profile => ({ ...p, notes: (p.notes ?? []).filter((x) => x.id !== id) })

// ── The brief: what the tutor reads before planning a lesson or a question ──

const pct = (t: TopicStat) => Math.round(recentScore(t) * 100)

/** Share of recent answers right (partly right counts half). */
export const recentScore = (t: TopicStat) => t.recent.reduce((a, b) => a + b, 0) / Math.max(1, t.recent.length)

export type TopicState = 'untried' | 'shaky' | 'building' | 'strong' | 'top'

/**
 * How a topic is going. The one rule everything uses (the tutor's brief, the
 * Progress page): shaky below 60 % recently; strong when solid (85 %+, at least
 * twice, in two situations) at level 2; top when solid at level 3.
 */
export function topicState(t: TopicStat | undefined): TopicState {
  if (!t) return 'untried'
  const r = recentScore(t)
  if (r < 0.6) return 'shaky'
  // The same proof as for a skill (PROOF): right on their own, in two lessons and two situations, hard enough.
  const proof = (g: (typeof PROOF)['strong' | 'top']) => meetsProof(t.rightIn ?? [], g)
  return r >= 0.85 && proof(PROOF.top) ? 'top' : r >= 0.85 && proof(PROOF.strong) ? 'strong' : 'building'
}

/**
 * A high number is not enough: strong and top also need proof, from graded answers that
 * were right without help (rightIn), in more than one lesson, at a high enough difficulty
 * and in more than one situation. The one definition, for topics and skills alike.
 */
export const PROOF = {
  strong: { right: 3, lessons: 2, minDifficulty: 2, contexts: 2 },
  top: { right: 4, lessons: 2, minDifficulty: 3, contexts: 2 }
} as const

export function meetsProof(entries: TopicStat['rightIn'], g: (typeof PROOF)['strong' | 'top']): boolean {
  return entries.length >= g.right &&
    new Set(entries.map((e) => e.session)).size >= g.lessons &&
    Math.max(0, ...entries.map((e) => e.d ?? 1)) >= g.minDifficulty &&
    new Set(entries.map((e) => e.ctx ?? '')).size >= g.contexts
}
const daysAgo = (iso: string, now: string) => Math.max(0, Math.round((new Date(now).getTime() - new Date(iso).getTime()) / DAY))

export interface BriefParts {
  due: TopicId[]
  weak: TopicId[]
  strong: TopicId[]
  text: string
}

/**
 * A compact, bounded summary of the learner for planning (a few hundred words
 * however long they have used the app): goals, skill levels and trends, weak and
 * strong topics, what is due for review, live misconceptions, what was asked
 * recently, notes and the last lessons.
 */
export function learnerBrief(p: Profile, now: string): BriefParts {
  const topics = Object.entries(p.topics ?? {}) as Array<[TopicId, TopicStat]>
  const lessons = lessonsOf(p)
  const ref = lessons.slice(-3)[0]?.skillsAtStart
  const lines: string[] = []

  const goals = [p.background.goals, ...(p.notes ?? []).filter((n) => n.category === 'goal').map((n) => n.text)].filter(Boolean)
  if (goals.length) lines.push(`Goals: ${goals.join(' · ')}`)

  lines.push('Skills (mastery, change over the last lessons, level to aim at next):')
  for (const s of SKILLS) {
    const st = p.skills[s.id]
    const d = ref?.[s.id] !== undefined ? st.mastery - ref[s.id]! : 0
    const trend = Math.abs(d) < 0.02 ? '' : d > 0 ? ` ↑${d.toFixed(2)}` : ` ↓${Math.abs(d).toFixed(2)}`
    const own = topics.filter(([id]) => topicDef(id)?.skill === s.id)
    const aim = own.length ? Math.round(own.reduce((a, [, t]) => a + t.level, 0) / own.length) : st.mastery < 0.4 ? 1 : st.mastery < 0.7 ? 2 : 3
    lines.push(`- ${s.id} ${st.mastery.toFixed(2)}${trend} · aim level ${aim}${st.evidence < 3 ? ' · little evidence yet' : ''}`)
  }

  const due = topics.filter(([, t]) => t.due <= now).sort((a, b) => a[1].box - b[1].box || a[1].due.localeCompare(b[1].due)).map(([id]) => id)
  const weak = topics.filter(([, t]) => topicState(t) === 'shaky').sort((a, b) => pct(a[1]) - pct(b[1])).map(([id]) => id)
  const strong = topics.filter(([, t]) => topicState(t) === 'strong' || topicState(t) === 'top').map(([id]) => id)
  const desc = (id: TopicId) => {
    const t = p.topics![id]!
    return `${id} (${topicDef(id)!.name}: ${t.correct}/${t.seen} right, recent ${pct(t)}%, aim ${t.level}, last ${daysAgo(t.lastSeen, now)}d ago)`
  }
  if (weak.length) lines.push(`Weak topics: ${weak.slice(0, 4).map(desc).join('; ')}`)
  if (due.length) lines.push(`Due for review: ${due.slice(0, 4).map(desc).join('; ')}`)
  if (strong.length) lines.push(`Solid: ${strong.slice(0, 5).join(', ')}`)
  const untried = TOPICS.filter((t) => !p.topics?.[t.id] && (p.skills[t.skill]?.mastery ?? 0) >= 0.3).map((t) => t.id)
  if (untried.length) lines.push(`Not practised yet (within reach): ${untried.slice(0, 6).join(', ')}`)

  const live = p.misconceptions.filter((m) => !m.resolved)
    .sort((a, b) => Number(!!b.confident) - Number(!!a.confident) || b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count).slice(0, 4)
  if (live.length) {
    lines.push(`Live misconceptions: ${live.map((m) => {
      const so = misconceptionSignOff(p, m)
      // The bar's reason only when it isn't the standard one.
      const bar = /^a (lower|higher) bar/.test(so.why) ? ` (${so.why})` : ''
      return `[${m.id}] ${m.description} (${inferTopic(m) ?? m.skill}, ${m.count}×${m.relapses ? `, back ${m.relapses}× after clearing` : ''}${m.confident ? ', they were sure: undo this first' : ''}) ${SIGNOFF_WORDS[so.status]}, ${so.points}/${so.required}${bar}`
    }).join('; ')}`)
  }
  // Cleared, not yet confirmed: check each once more in a fresh situation.
  const recheck = p.misconceptions.filter((m) => m.resolved && misconceptionSignOff(p, m).status === 'cleared').slice(0, 3)
  if (recheck.length) lines.push(`Cleared, to re-check in a later lesson (one clean answer in a new situation confirms it): ${recheck.map((m) => `[${m.id}] ${m.description}`).join('; ')}`)
  const cal = calibrationOf(p)
  if (cal.verdict !== 'unknown') {
    const pc = (x: { n: number; right: number }) => (x.n ? `${Math.round((x.right / x.n) * 100)}% right (${x.n})` : 'no answers')
    const says = { under: 'underconfident: right far more often than they feel. Point it out with the numbers; stretch them.', over: 'overconfident: often wrong when sure. Ask them to check before committing.', fair: 'judges themselves fairly.' }[cal.verdict]
    lines.push(`Self-judgement: when sure ${pc(cal.sure)}, unsure ${pc(cal.unsure)}, guessing ${pc(cal.guess)}: ${says}`)
  }

  const asked = (p.asked ?? []).slice(-8)
  if (asked.length) lines.push(`Recently asked (vary; don't repeat): ${asked.map((a) => `${a.kind}/${a.topic} L${a.difficulty}: "${a.text}"`).join('; ')}`)

  const notes = (p.notes ?? []).filter((n) => n.category !== 'goal')
  if (notes.length) lines.push(`Your notes: ${notes.slice(-12).map((n) => `[${n.id} · ${n.category}] ${n.text}`).join('; ')}`)

  const recent = lessons.slice(-4)
  if (recent.length) {
    lines.push('Recent lessons:')
    for (const s of recent) {
      const ex = s.exercises.length ? `, ${s.exercises.filter((e) => e.passed).length}/${s.exercises.length} graded right` : ''
      lines.push(`- ${s.startedAt.slice(0, 10)}: ${s.plan?.goal ?? s.focus ?? 'open conversation'} (${s.outcome ?? 'unfinished'}${ex})${s.recap?.practiseNext ? `; next: ${s.recap.practiseNext}` : ''}`)
    }
    const last = [...recent].reverse().find((s) => s.summary)
    if (last) lines.push(`Last lesson summary: ${last.summary!.slice(0, 600)}`)
  }
  return { due, weak, strong, text: lines.join('\n') }
}
