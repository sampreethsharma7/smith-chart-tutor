import type { SessionRecord } from './profile'

export type Coordinates = 'impedance' | 'admittance' | 'unknown'

/**
 * Which coordinates a lesson step reads the chart in, from the words used.
 * Never defaults: if the evidence isn't clearly one-sided the answer is
 * "unknown", and the tutor must establish it before describing any move.
 */
const ADMITTANCE = [
  /\by\s*[≈=]\s*-?\d[\d.]*\s*[+−-]\s*j/gi, // y = 1.15 − j0.77
  /\bconstant[- ]g\b|\bg\s*=\s*\d/gi,
  /\badmittance\b/gi,
  /\bsusceptance\b|\bb\s*[<>=]\s*-?\d/gi,
  /\bshunt\b/gi
]
const IMPEDANCE = [
  /\bz\s*[≈=]\s*-?\d[\d.]*\s*[+−-]\s*j/gi, // z = 0.6 + j0.4
  /\bconstant[- ]r\b|\br\s*=\s*\d/gi,
  /\bimpedance\b/gi,
  /\breactance\b|\bx\s*[<>=]\s*-?\d/gi,
  /\bseries\b/gi
]

const count = (text: string, res: RegExp[]) => res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0)

export function scoreCoordinates(text: string): { admittance: number; impedance: number } {
  return { admittance: count(text, ADMITTANCE), impedance: count(text, IMPEDANCE) }
}

/** Strong evidence only: at least 2 signals, and at least twice as many as the other side. */
function decide(adm: number, imp: number): Coordinates {
  if (adm >= 2 && adm >= 2 * imp) return 'admittance'
  if (imp >= 2 && imp >= 2 * adm) return 'impedance'
  return 'unknown'
}

/** From a step's own wording (used when a goal or step is set without saying). */
export function inferFromStepText(step: string): Coordinates {
  const s = scoreCoordinates(step)
  return decide(s.admittance, s.impedance)
}

/**
 * For a lesson saved before coordinates were recorded: the current step's
 * wording counts most, then what the tutor said most recently.
 */
export function inferLessonCoordinates(session: SessionRecord): Coordinates {
  const plan = session.plan
  if (!plan) return 'unknown'
  const step = plan.steps[Math.min(plan.step, plan.steps.length - 1)] ?? ''
  const stepScore = scoreCoordinates(step)
  const recent = session.transcript.filter((t) => t.role === 'tutor').slice(-4).map((t) => t.text).join('\n')
  const talk = scoreCoordinates(recent)
  return decide(3 * stepScore.admittance + talk.admittance, 3 * stepScore.impedance + talk.impedance)
}

/** Fill in coordinates for a legacy lesson (inferred, or explicitly unknown). Leaves recorded ones alone. */
export function migrateLessonState(session: SessionRecord): SessionRecord {
  const plan = session.plan
  if (!plan || plan.coordinates) return session
  return { ...session, plan: { ...plan, coordinates: inferLessonCoordinates(session), coordinatesInferred: true } }
}
