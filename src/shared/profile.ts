/** Learner profile: what the tutor knows about a person, persisted per profile. */
import type { Answer, Question } from './assessment'
import type { AskedItem, Note, TopicId, TopicStat } from './memory'
import type { Slip } from './patterns'
import type { Observation } from './signoff'

export type SkillId =
  | 'chart_basics'
  | 'reflection'
  | 'admittance'
  | 'lumped_moves'
  | 'l_match'
  | 'tlines'
  | 'stubs'
  | 'q_bandwidth'
  | 'sweep_reading'

export interface SkillDef {
  id: SkillId
  name: string
  description: string
  prerequisites: SkillId[]
}

export const SKILLS: SkillDef[] = [
  { id: 'chart_basics', name: 'Chart anatomy & normalization', description: 'Normalize Z to z, read constant-r circles and constant-x arcs, plot opens/shorts/matched points.', prerequisites: [] },
  { id: 'reflection', name: 'Γ, VSWR & return loss', description: 'Relate distance from centre to |Γ|, VSWR circles, return loss and mismatch loss.', prerequisites: ['chart_basics'] },
  { id: 'admittance', name: 'Admittance & Z↔Y', description: 'Rotate 180° to get y, read the admittance grid, know when to work in Y.', prerequisites: ['chart_basics'] },
  { id: 'lumped_moves', name: 'Series/shunt L & C moves', description: 'Predict the direction a series or shunt L/C moves a point (constant-r vs constant-g circles).', prerequisites: ['admittance'] },
  { id: 'l_match', name: 'L-network matching', description: 'Design two-element L-matches, pick between the two solutions, compute component values.', prerequisites: ['lumped_moves', 'reflection'] },
  { id: 'tlines', name: 'Transmission lines', description: 'Rotation toward generator/load, WTG/WTL, λ/4 transformers, line Z0 ≠ system Z0.', prerequisites: ['reflection'] },
  { id: 'stubs', name: 'Stub matching', description: 'Single-stub (open/short) matching: line to the g = 1 circle, then cancel susceptance.', prerequisites: ['tlines', 'admittance'] },
  { id: 'q_bandwidth', name: 'Q & bandwidth', description: 'Node Q contours, loaded Q vs bandwidth, multi-section/low-Q matching for wideband.', prerequisites: ['l_match'] },
  { id: 'sweep_reading', name: 'Reading antenna sweeps', description: 'Interpret frequency traces: resonance, loops/kinks, clockwise rotation, using CST/VNA data to choose a match.', prerequisites: ['reflection', 'lumped_moves'] }
]

export const skillName = (id: string) => SKILLS.find((s) => s.id === id)?.name ?? (id === 'probe' ? 'Check yourself' : id)

/** What a lesson is about: a skill, the learner's own question, or a "check yourself" session. */
export type LessonFocus = SkillId | 'own' | 'probe'

export interface SkillState {
  /** 0..1 estimate of mastery */
  mastery: number
  /** 0..1 how sure we are about `mastery` (grows with evidence) */
  confidence: number
  evidence: number
  lastPracticed?: string
  history: Array<{ at: string; mastery: number; source: string }>
}

export interface Misconception {
  id: string
  skill: SkillId
  description: string
  count: number
  firstSeen: string
  lastSeen: string
  resolved: boolean
  /** The specific topic it is about, so graded answers can close or reopen it */
  topic?: TopicId
  resolvedAt?: string
  /** They were sure of the wrong answer: a real mental model to undo, not a slip */
  confident?: boolean
  /** Lessons it was seen in (newest last): right answers in these never clear it */
  sessions?: string[]
  /** Situations (graded contexts) it was seen in, to tell when a right answer is in a new one */
  ctxs?: string[]
  /** Times it came back after being cleared: raises the bar for clearing it again (signoff.ts) */
  relapses?: number
}

export interface SessionRecord {
  id: string
  startedAt: string
  endedAt?: string
  provider?: string
  /** What the learner chose to work on (absent = tutor's pick; probe = a "check yourself" session) */
  focus?: LessonFocus
  /** The tutor marked the goal reached; the lesson stays open until the learner finishes it */
  goalReachedAt?: string
  /** After the goal, the learner chose to keep going in the same lesson */
  keptGoing?: boolean
  /** The tutor's goal for the lesson and the steps to it; `step` = index of the current step */
  plan?: {
    goal: string
    steps: string[]
    step: number
    /** learner turns when it was set */
    setAtTurn?: number
    /** Which coordinates the current step reads the chart in; "unknown" must be established before any move is described */
    coordinates?: 'impedance' | 'admittance' | 'unknown'
    /** Set when coordinates were inferred for a lesson saved before they were recorded */
    coordinatesInferred?: boolean
  }
  /** completed = goal reached (the tutor closed it); partial = finished early */
  outcome?: 'completed' | 'partial'
  /** The tutor's recap when the goal was reached */
  recap?: { canNowDo: string[]; practiseNext?: string }
  /** Mastery per skill when the lesson started, to show what moved */
  skillsAtStart?: Partial<Record<SkillId, number>>
  skillsAtEnd?: Partial<Record<SkillId, number>>
  summary?: string
  /** Running notes on the lesson so far, for the part that no longer fits the tutor's context: transcript[0, upTo) */
  digest?: { text: string; upTo: number }
  /** Messages in the lesson when its transcript was shortened for storage (older lessons keep their summary and the last messages) */
  messageCount?: number
  /** Compact transcript: role + text only (tool chatter dropped) */
  transcript: Array<{ role: 'user' | 'tutor'; text: string; at: string; /** model that wrote a tutor message */ model?: string }>
  /** Tutor models used in this lesson, in order (more than one = switched mid-lesson) */
  models?: string[]
  /** Graded tasks and questions: kind is match / reach (task cards) or locate / move / value (questions); older records have none */
  exercises: Array<{ id?: string; kind?: string; title: string; skill?: SkillId; passed: boolean; attempts: number; at: string }>
}

/** A lesson counts once the learner has taken part: answered, predicted or checked an exercise. */
export const countsAsLesson = (s: SessionRecord) => s.transcript.some((t) => t.role === 'user') || s.exercises.length > 0

export const lessonsOf = (p: Profile) => p.sessions.filter(countsAsLesson)

/** Something earlier to review: a summarised lesson or an open misconception. */
export const hasReviewMaterial = (p: Profile) =>
  lessonsOf(p).some((s) => s.summary) || p.misconceptions.some((m) => !m.resolved)

export const masterySnapshot = (skills: Record<SkillId, SkillState>): Partial<Record<SkillId, number>> =>
  Object.fromEntries(Object.entries(skills).map(([id, s]) => [id, s.mastery]))

/** Skills whose mastery moved during a lesson (start → end, or → now while it runs), biggest change first. */
export function skillChanges(s: SessionRecord, now: Record<SkillId, SkillState>): Array<{ id: SkillId; from: number; to: number }> {
  if (!s.skillsAtStart) return []
  return (Object.keys(s.skillsAtStart) as SkillId[])
    .map((id) => ({ id, from: s.skillsAtStart![id] ?? 0, to: s.skillsAtEnd?.[id] ?? now[id]?.mastery ?? 0 }))
    .filter((c) => Math.abs(c.to - c.from) >= 0.01)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
}

export interface AssessmentResult {
  takenAt: string
  perSkill: Partial<Record<SkillId, { correct: number; total: number }>>
  answers: Array<{ questionId: string; correct: boolean; skipped: boolean; ms: number }>
  level: Level
}

export interface AssessmentDraft {
  questions: Question[]
  idx: number
  answers: Answer[]
  /** Feedback for the current question once answered */
  feedback: { ok: boolean; skipped: boolean } | null
  /** When the current question was shown (for answer timing) */
  shownAt: number
  startedAt: string
}

export type Level = 'Beginner' | 'Developing' | 'Proficient' | 'Advanced'

export interface Profile {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  background: {
    experience: 'new' | 'basics' | 'intermediate' | 'advanced'
    role: string
    goals: string
    /** Free-text notes for the tutor (how they learn best, what to emphasise) */
    mentorNotes: string
  }
  preferences: {
    tutorStyle: 'socratic' | 'balanced' | 'direct'
    /** No longer used (lessons end at their goal, not a time limit); kept so old files load */
    sessionMinutes: number
    defaultZ0: number
    /** Open each lesson with one optional review question on earlier material */
    reviewFirst?: boolean
  }
  skills: Record<SkillId, SkillState>
  assessment?: AssessmentResult
  /** Placement test in progress (saved after every answer so it survives tab switches and restarts) */
  assessmentDraft?: AssessmentDraft
  /** The learner has been through profile setup at least once */
  setupComplete: boolean
  /** Chose to skip the placement test and let the tutor gauge their level */
  skippedAssessment?: boolean
  misconceptions: Misconception[]
  sessions: SessionRecord[]
  /** Older plain-text notes; carried over into `notes` when the profile loads */
  tutorNotes: string[]
  /** The tutor's notes about this learner, a few per category */
  notes?: Note[]
  /** Per-topic results, the level to aim at next and when to review (kept by the app from graded answers) */
  topics?: Partial<Record<TopicId, TopicStat>>
  /** The last graded items set, so they aren't repeated */
  asked?: AskedItem[]
  /** Wrong answers that showed a known confusion (patterns.ts), kept so patterns across lessons can be seen */
  slips?: Slip[]
  /** How sure they said they were on graded questions, and whether they were right (newest last) */
  calibration?: Array<{ sure: Sure; right: boolean; at: string; topic?: TopicId }>
  /** The tutor's structured observations of what the app can't grade: the reason they gave, and transfer (signoff.ts) */
  observations?: Observation[]
  /**
   * Every graded answer, newest last (the last ANSWER_LOG_MAX): what, where and how it went. The
   * learner model works from summaries; this keeps the raw history so new measures (e.g. a
   * per-topic record for sign-off) can be built from real data later.
   */
  answers?: AnswerRecord[]
  /** Scoring version the skills were last brought up to (see rescore) */
  scoring?: number
  /**
   * What to work on next, as the tutor decided it (set_next_focus). The one place the
   * pick lives: the tutor plans from it, Progress and the lesson launcher show it.
   */
  nextFocus?: NextFocus
}

export interface NextFocus {
  picks: Array<{ skill: SkillId; topic?: TopicId; why: string }>
  at: string
  /** The tutor model that set it, and in which lesson */
  model?: string
  session?: string
}

const now = () => new Date().toISOString()

export function newSkillState(mastery = 0.15, confidence = 0): SkillState {
  return { mastery, confidence, evidence: 0, history: [] }
}

const EXPERIENCE_PRIOR: Record<Profile['background']['experience'], number> = {
  new: 0.05, basics: 0.3, intermediate: 0.55, advanced: 0.75
}

export function createProfile(name: string, background: Partial<Profile['background']> = {}): Profile {
  const experience = background.experience ?? 'basics'
  const prior = EXPERIENCE_PRIOR[experience]
  return {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: now(),
    updatedAt: now(),
    background: { experience, role: '', goals: '', mentorNotes: '', ...background },
    preferences: { tutorStyle: 'socratic', sessionMinutes: 30, defaultZ0: 50 },
    skills: Object.fromEntries(SKILLS.map((s) => [s.id, newSkillState(prior)])) as Record<SkillId, SkillState>,
    setupComplete: false,
    scoring: SCORING,
    misconceptions: [],
    sessions: [],
    tutorNotes: []
  }
}

/**
 * Start over: everything the app has learned about them goes (skills back to their stated
 * experience, lessons, answers, mistakes, the tutor's notes, the plan, the placement test). Who
 * they are and how they like to learn stay: the profile's id, name, background and preferences.
 */
export function resetProgress(p: Profile): Profile {
  const fresh = createProfile(p.name, p.background)
  return { ...fresh, id: p.id, createdAt: p.createdAt, preferences: p.preferences, setupComplete: p.setupComplete }
}

/** Fill in any fields missing from older/imported profiles. */
export function migrateProfile(p: Profile): Profile {
  const base = createProfile(p.name ?? 'Learner', p.background ?? {})
  const skills = { ...base.skills, ...(p.skills ?? {}) }
  return {
    ...base,
    ...p,
    background: { ...base.background, ...(p.background ?? {}) },
    preferences: { ...base.preferences, ...(p.preferences ?? {}) },
    // Profiles from before onboarding existed count as set up once they've been used.
    setupComplete: p.setupComplete ?? Boolean(p.assessment || p.sessions?.length),
    misconceptions: p.misconceptions ?? [],
    sessions: p.sessions ?? [],
    ...migrateNotes(p),
    ...rescore(p, skills),
    ...(p.topics ? { topics: migrateTopics(p.topics) } : {})
  }
}

/** Topics saved before a field existed get its empty default, so nothing downstream trips on it. */
function migrateTopics(topics: NonNullable<Profile['topics']>): NonNullable<Profile['topics']> {
  return Object.fromEntries(Object.entries(topics).map(([id, t]) => [id, t && {
    ...t, recent: t.recent ?? [], rightIn: t.rightIn ?? [], streak: t.streak ?? 0, box: t.box ?? 0, level: t.level ?? 1, seen: t.seen ?? 0, correct: t.correct ?? 0
  }]))
}

/** Scoring version: 2 = only graded work can take a skill past JUDGEMENT_CAP. */
export const SCORING = 2

/**
 * Profiles scored before evidence was weighted: a skill with no graded answers behind it
 * (only the placement test or the tutor's judgement) comes down to JUDGEMENT_CAP. Once.
 */
function rescore(p: Profile, skills: Record<SkillId, SkillState>): Pick<Profile, 'skills' | 'scoring'> {
  if ((p.scoring ?? 1) >= SCORING) return { skills, scoring: p.scoring }
  const at = now()
  const next = Object.fromEntries(Object.entries(skills).map(([id, s]) => {
    const graded = s.history.some((h) => h.source.startsWith('app:'))
    if (graded || s.mastery <= JUDGEMENT_CAP) return [id, s]
    return [id, { ...s, mastery: JUDGEMENT_CAP, history: [...s.history, { at, mastery: JUDGEMENT_CAP, source: 'rescored: no graded answers yet' }].slice(-60) }]
  })) as Record<SkillId, SkillState>
  return { skills: next, scoring: SCORING }
}

/** Plain-text notes ("2026-10-06: …") from before notes had categories become "other" notes. */
function migrateNotes(p: Profile): Pick<Profile, 'tutorNotes' | 'notes'> {
  if (p.notes || !p.tutorNotes?.length) return { tutorNotes: p.tutorNotes ?? [], notes: p.notes ?? [] }
  const notes: Note[] = p.tutorNotes.slice(-15).map((t, i) => {
    const m = /^(\d{4}-\d{2}-\d{2}):\s*([\s\S]*)$/.exec(t)
    const text = (m ? m[2] : t).trim()
    return { id: `n_old${i}`, category: 'other', text: text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text, at: m ? `${m[1]}T00:00:00.000Z` : new Date(0).toISOString() }
  })
  return { tutorNotes: [], notes }
}

export type Outcome = 'correct' | 'partial' | 'incorrect'

/** One graded answer, as it happened (before any adjustment for help or guessing). */
export interface AnswerRecord {
  at: string
  session: string
  topic: TopicId
  skill: SkillId
  difficulty: number
  outcome: Outcome
  sure?: Sure
  helped?: boolean
  format?: string
  /** The situation it was in (e.g. upper half, r < 1) */
  ctx?: string
}

export const ANSWER_LOG_MAX = 1000

/** How sure the learner said they were of an answer, before seeing the result. */
export type Sure = 'sure' | 'unsure' | 'guess'

/**
 * Evidence-based mastery update. The tutor reports what it observed; the
 * arithmetic stays deterministic so progress is comparable across models.
 */
export function applyEvidence(
  s: SkillState, outcome: Outcome, difficulty: 1 | 2 | 3, source: string,
  /**
   * weight: how much this answer proves (0–1): a multiple-choice pick that could be a guess
   * proves less than a click, a typed value or a task. cap: the highest this kind of evidence
   * may take mastery (judgement and the placement test can't make a skill strong).
   */
  opts: { weight?: number; cap?: number; floor?: boolean; trust?: number } = {}
): SkillState {
  // Bad input (a model sending "high" or nothing) never reaches the record.
  if (!Number.isFinite(s.mastery) || !['correct', 'partial', 'incorrect'].includes(outcome)) return s
  if (![1, 2, 3].includes(difficulty)) difficulty = 2
  const w = Math.min(1, Math.max(0, Number.isFinite(opts.weight) ? opts.weight! : 1))
  // trust: how much this adds to our confidence in the estimate (default: its weight).
  const trust = Math.min(1, Math.max(0, Number.isFinite(opts.trust) ? opts.trust! : w))
  const d = difficulty - 1
  const target =
    outcome === 'correct' ? [0.6, 0.8, 1][d] : outcome === 'partial' ? [0.35, 0.5, 0.65][d] : [0, 0.1, 0.2][d]
  const lr = 0.35 * (1 - 0.6 * s.confidence) * w
  let m = s.mastery + lr * (target - s.mastery)
  // floor: a right answer that counts as partial (with help, or a guess) never lowers the skill.
  if (outcome === 'correct' || opts.floor) m = Math.max(m, s.mastery)
  if (outcome === 'incorrect') m = Math.min(m, s.mastery)
  if (opts.cap !== undefined) m = Math.min(m, Math.max(s.mastery, opts.cap))
  m = Math.min(1, Math.max(0, m))
  return {
    mastery: m,
    confidence: Math.min(1, s.confidence + 0.08 * trust),
    evidence: s.evidence + 1,
    lastPracticed: now(),
    history: [...s.history, { at: now(), mastery: m, source }].slice(-60)
  }
}

/** Highest mastery that judgement alone (the tutor's, the placement test) can give: below strong. */
export const JUDGEMENT_CAP = 0.6

/** The tutor's override: free to lower a skill, but raising it past JUDGEMENT_CAP takes graded work. */
export function setMastery(s: SkillState, mastery: number, source: string): SkillState {
  if (!Number.isFinite(mastery)) return s
  const m = Math.min(1, Math.max(0, mastery > s.mastery ? Math.min(mastery, Math.max(s.mastery, JUDGEMENT_CAP)) : mastery))
  return { ...s, mastery: m, lastPracticed: now(), history: [...s.history, { at: now(), mastery: m, source }].slice(-60) }
}

export function overallLevel(skills: Record<SkillId, SkillState>): { level: Level; avg: number } {
  const vals = Object.values(skills).map((s) => s.mastery)
  const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)
  const level: Level = avg < 0.3 ? 'Beginner' : avg < 0.55 ? 'Developing' : avg < 0.8 ? 'Proficient' : 'Advanced'
  return { level, avg }
}

/** Export a profile (backup or moving to another PC). An in-progress test isn't included. */
export function exportProfile(p: Profile): Profile & { format: string } {
  return { ...p, assessmentDraft: undefined, format: 'smith-tutor-profile/1' }
}
