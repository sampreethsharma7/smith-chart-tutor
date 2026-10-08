import { Complex, c, abs, sub } from './rf/complex'
import type { AssessmentResult, Profile, SkillId } from './profile'
import { JUDGEMENT_CAP, overallLevel, SKILLS } from './profile'

/**
 * Placement test. Graded deterministically (not by the LLM) so the starting
 * level is reliable no matter which model is used as tutor.
 */
export type Question =
  | { id: string; skill: SkillId; kind: 'mcq'; prompt: string; choices: string[]; answer: number; explain: string }
  | { id: string; skill: SkillId; kind: 'numeric'; prompt: string; answer: number; tol: number; unit?: string; explain: string }
  | { id: string; skill: SkillId; kind: 'click'; prompt: string; target: Complex; tol: number; show?: Complex; explain: string }

export const QUESTIONS: Question[] = [
  // chart_basics
  { id: 'cb1', skill: 'chart_basics', kind: 'click', prompt: 'Click where z = 1 + j1.', target: c(0.2, 0.4), tol: 0.08,
    explain: 'z = 1 + j1 sits where the r = 1 circle meets the x = +1 arc, upper half (inductive).' },
  { id: 'cb2', skill: 'chart_basics', kind: 'mcq', prompt: 'Z0 = 50 Ω. A load of 25 − j50 Ω normalizes to:',
    choices: ['0.5 − j1', '25 − j50', '2 + j1', '0.5 + j1'], answer: 0,
    explain: 'Divide by Z0: z = Z/Z0 = 0.5 − j1. The sign of the reactance never changes.' },
  { id: 'cb3', skill: 'chart_basics', kind: 'click', prompt: 'Click the short-circuit point.', target: c(-1, 0), tol: 0.1,
    explain: 'A short has Γ = −1: the leftmost point of the chart.' },
  // reflection
  { id: 'rf1', skill: 'reflection', kind: 'numeric', prompt: '|Γ| = 0.5. What is the VSWR?', answer: 3, tol: 0.05,
    explain: 'VSWR = (1 + |Γ|)/(1 − |Γ|) = 1.5/0.5 = 3.' },
  { id: 'rf2', skill: 'reflection', kind: 'numeric', prompt: 'VSWR = 2. What is the return loss?', answer: 9.54, tol: 0.2, unit: 'dB',
    explain: '|Γ| = (2−1)/(2+1) = 1/3; RL = −20·log10(1/3) ≈ 9.54 dB.' },
  { id: 'rf3', skill: 'reflection', kind: 'mcq', prompt: 'Every point on a circle centred on the chart centre has the same:',
    choices: ['|Γ| (and VSWR)', 'Resistance', 'Reactance', 'Q'], answer: 0,
    explain: 'Distance from the centre is |Γ|, so concentric circles are constant-VSWR circles.' },
  // admittance
  { id: 'ad1', skill: 'admittance', kind: 'mcq', prompt: 'z = 1 + j1. What is the normalized admittance y?',
    choices: ['0.5 − j0.5', '1 − j1', '0.5 + j0.5', '2 − j2'], answer: 0,
    explain: 'y = 1/(1 + j1) = (1 − j1)/2 = 0.5 − j0.5.' },
  { id: 'ad2', skill: 'admittance', kind: 'click', prompt: 'The marker shows z = 0.5 + j0.5. Click the point that represents its admittance y (read on the same chart).',
    target: c(0.2, -0.4), tol: 0.08, show: c(-0.2, 0.4),
    explain: 'y is found by rotating 180° about the centre: diametrically opposite the z point.' },
  // lumped_moves
  { id: 'lm1', skill: 'lumped_moves', kind: 'mcq', prompt: 'Adding a SERIES INDUCTOR moves the point:',
    choices: ['Clockwise along a constant-resistance circle', 'Counter-clockwise along a constant-resistance circle',
      'Clockwise along a constant-conductance circle', 'Radially toward the centre'], answer: 0,
    explain: 'Series elements keep r constant; +jX (inductor) moves clockwise toward the upper half.' },
  { id: 'lm2', skill: 'lumped_moves', kind: 'mcq', prompt: 'Adding a SHUNT CAPACITOR moves the point:',
    choices: ['Clockwise along a constant-conductance circle', 'Counter-clockwise along a constant-conductance circle',
      'Clockwise along a constant-resistance circle', 'Counter-clockwise along a constant-resistance circle'], answer: 0,
    explain: 'Shunt elements keep g constant; +jB (capacitor) moves clockwise. Series L and shunt C both go clockwise.' },
  // l_match
  { id: 'lmt1', skill: 'l_match', kind: 'numeric', prompt: 'Match R_L = 25 Ω to 50 Ω with a low-pass L-network (series L next to the load, shunt C on the 50 Ω side). What is the series reactance X_L?',
    answer: 25, tol: 1, unit: 'Ω', explain: 'Q = √(50/25 − 1) = 1, so X_series = Q·R_L = 25 Ω (and X_shunt = 50/Q = 50 Ω).' },
  { id: 'lmt2', skill: 'l_match', kind: 'mcq', prompt: 'The load is z = 0.4 (pure resistance, r < 1). Which first move (at the load) leads to an L-match?',
    choices: ['A series element, to land on the g = 1 circle', 'A shunt element, to land on the r = 1 circle',
      'Nothing works: r < 1 cannot be matched with an L-network', 'Any element; order never matters'], answer: 0,
    explain: 'z = 0.4 lies inside the g = 1 circle; shunt moves keep g = 2.5 and never reach r = 1, so go series first.' },
  // tlines
  { id: 'tl1', skill: 'tlines', kind: 'numeric', prompt: 'A quarter-wave transformer matches 200 Ω to 50 Ω. What line impedance is needed?',
    answer: 100, tol: 1, unit: 'Ω', explain: 'Zc = √(Z_in·Z_L) = √(50·200) = 100 Ω.' },
  { id: 'tl2', skill: 'tlines', kind: 'mcq', prompt: 'Moving toward the GENERATOR along a lossless line (Zc = Z0) moves the point:',
    choices: ['Clockwise on a constant-|Γ| circle', 'Counter-clockwise on a constant-|Γ| circle', 'Along a constant-r circle', 'Toward the centre'], answer: 0,
    explain: 'The line only changes the phase of Γ; toward generator = clockwise (WTG scale).' },
  { id: 'tl3', skill: 'tlines', kind: 'numeric', prompt: 'How many wavelengths of line make one full trip around the Smith chart?',
    answer: 0.5, tol: 0.01, unit: 'λ', explain: 'Γ goes round twice as fast as the line phase (round trip), so 360° = λ/2.' },
  // stubs
  { id: 'st1', skill: 'stubs', kind: 'mcq', prompt: 'In single shunt-stub matching, the line section from the load should bring the admittance onto:',
    choices: ['The g = 1 circle', 'The r = 1 circle', 'The real axis', 'The outer rim (|Γ| = 1)'], answer: 0,
    explain: 'On g = 1 the stub only needs to cancel the susceptance: y = 1 ± jb → 1.' },
  { id: 'st2', skill: 'stubs', kind: 'numeric', prompt: 'After the line section, y = 1 + j0.8. What normalized susceptance must the stub add?',
    answer: -0.8, tol: 0.02, explain: 'The stub must cancel +j0.8, so b_stub = −0.8 (inductive).' },
  // q_bandwidth
  { id: 'qb1', skill: 'q_bandwidth', kind: 'numeric', prompt: 'What is the node Q at z = 0.5 + j1.5?', answer: 3, tol: 0.05,
    explain: 'Q = |x|/r = 1.5/0.5 = 3.' },
  { id: 'qb2', skill: 'q_bandwidth', kind: 'mcq', prompt: 'To widen the bandwidth of a match from a high-Q load, the matching path should:',
    choices: ['Stay inside a low-Q contour, e.g. by using more sections', 'Take the highest-Q path possible',
      'Use one L-section with the largest component values', 'Q has no effect on bandwidth'], answer: 0,
    explain: 'Loaded Q ≈ highest node Q on the path; lower Q → wider bandwidth. Multi-section matches keep Q low.' },
  // sweep_reading
  { id: 'sw1', skill: 'sweep_reading', kind: 'mcq', prompt: 'For a passive antenna, as frequency increases the S11 trace on the Smith chart moves:',
    choices: ['Clockwise', 'Counter-clockwise', 'Radially outward', 'It does not move'], answer: 0,
    explain: 'Foster\'s reactance theorem: reactance of a lossless passive network increases with frequency → clockwise rotation.' },
  { id: 'sw2', skill: 'sweep_reading', kind: 'mcq', prompt: 'A small loop (knot) appears in an antenna S11 trace near the band. It usually indicates:',
    choices: ['A second, coupled resonance — centring it can widen the bandwidth', 'Always a measurement error',
      'The antenna is lossless', 'The cable is too short'], answer: 0,
    explain: 'Loops come from coupled resonances (double-tuning); positioned around the centre they give broadband matches.' }
]

export interface Answer {
  questionId: string
  /** mcq: index; numeric: value; click: Γ point; null = "I don't know" */
  value: number | Complex | null
  ms: number
}

/**
 * Read a typed numeric answer leniently: "9.54 dB", "100 Ω", "−0.8" (Unicode minus),
 * "0,5" (decimal comma), "0.5λ", "1e2". Returns NaN if there is no number.
 */
export function parseNumericAnswer(s: string): number {
  const t = s.replace(/[−–—]/g, '-').replace(/(\d),(\d)/g, '$1.$2').trim()
  const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(t)
  return m ? Number(m[0]) : NaN
}

export function grade(q: Question, value: Answer['value']): boolean {
  if (value === null) return false
  if (q.kind === 'mcq') return value === q.answer
  if (q.kind === 'numeric') return typeof value === 'number' && Math.abs(value - q.answer) <= q.tol
  return typeof value === 'object' && abs(sub(value, q.target)) <= q.tol
}

/** Shuffle choices of MCQs so the answer is not always the first one. Deterministic per seed. */
export function shuffledQuestions(seed = Date.now()): Question[] {
  let s = seed % 2147483647
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647
  return QUESTIONS.map((q) => {
    if (q.kind !== 'mcq') return q
    const order = q.choices.map((_, i) => i).sort(() => rnd() - 0.5)
    return { ...q, choices: order.map((i) => q.choices[i]), answer: order.indexOf(q.answer) }
  })
}

export function scoreAssessment(qs: Question[], answers: Answer[], profile: Profile): { result: AssessmentResult; skills: Profile['skills'] } {
  const perSkill: AssessmentResult['perSkill'] = {}
  const graded = answers.map((a) => {
    const q = qs.find((x) => x.id === a.questionId)!
    const ok = grade(q, a.value)
    const ps = (perSkill[q.skill] ??= { correct: 0, total: 0 })
    ps.total++
    if (ok) ps.correct++
    return { questionId: a.questionId, correct: ok, skipped: a.value === null, ms: a.ms }
  })
  const at = new Date().toISOString()
  const skills = { ...profile.skills }
  for (const def of SKILLS) {
    const ps = perSkill[def.id]
    if (!ps) continue
    const frac = ps.correct / ps.total
    const prior = profile.skills[def.id].mastery
    // Graded answers in lessons outrank a few test questions: a retake leaves those skills alone.
    if (profile.skills[def.id].history.some((h) => h.source.startsWith('app:'))) continue
    // A few multiple-choice answers say where to start, not that a skill is mastered.
    const m = Math.min(JUDGEMENT_CAP, 0.25 * prior + 0.75 * frac)
    skills[def.id] = {
      ...skills[def.id],
      mastery: m,
      confidence: Math.max(skills[def.id].confidence, 0.35),
      evidence: skills[def.id].evidence + ps.total,
      history: [...skills[def.id].history, { at, mastery: m, source: 'placement test' }]
    }
  }
  return { result: { takenAt: at, perSkill, answers: graded, level: overallLevel(skills).level }, skills }
}
