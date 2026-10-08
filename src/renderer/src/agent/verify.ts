/**
 * Statements about how a point moves on the chart (direction, chart half, arc)
 * that the tutor must verify with what_if before saying them. Questions to the
 * learner ("clockwise or counter-clockwise?") are not claims.
 */
const MOVE_TERMS = /\b(counter[- ]?clockwise|anti[- ]?clockwise|clockwise|(upper|lower|top|bottom) half|cross(es|ed|ing)? (over )?(the )?(real |horizontal )?axis|around the (left|right) (edge|side))\b/i

export function moveClaims(text: string): string[] {
  return text
    .replace(/\*\*/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('?') && MOVE_TERMS.test(s))
}

export const COORDINATES_NUDGE =
  '[System] This lesson\'s coordinate system is UNKNOWN, so no direction or chart-half claim can be made yet. ' +
  'Decide from the current step whether you and the learner are reading the chart as impedance (z = r + jx) or admittance (y = g + jb), ' +
  'call set_lesson_coordinates with it, and say it to the learner in a few words if it could be unclear to them.'

export const VERIFY_NUDGE =
  '[System] Your last reply described how a point moves (direction, chart half or arc) without checking it this turn. ' +
  'Call what_if for that exact move now (start point and element), then write your reply again using its "move" facts: ' +
  'the circle it follows, the rotation, the start and end chart half (as the learner sees them on the chart) and any real-axis crossing. ' +
  'If anything you said earlier contradicts those facts, correct it plainly. Do not mention this check.'

// ── Direction rules the app can check on its own ──────────────────────────────

type MoveKind = 'seriesL' | 'seriesC' | 'shuntL' | 'shuntC' | 'lineToGenerator' | 'lineToLoad'

/** Which way each element turns the point on the impedance chart (+j up). Fixed physics, any value. */
const RULE: Record<MoveKind, 'clockwise' | 'counter-clockwise'> = {
  seriesL: 'clockwise',
  shuntC: 'clockwise',
  seriesC: 'counter-clockwise',
  shuntL: 'counter-clockwise',
  lineToGenerator: 'clockwise',
  lineToLoad: 'counter-clockwise'
}

const RULE_TEXT: Record<MoveKind, string> = {
  seriesL: 'a series L moves the point clockwise along its constant-r circle',
  seriesC: 'a series C moves it counter-clockwise along its constant-r circle',
  shuntC: 'a shunt C moves it clockwise along its constant-g circle',
  shuntL: 'a shunt L moves it counter-clockwise along its constant-g circle',
  lineToGenerator: 'adding line (moving toward the generator) turns it clockwise around the centre',
  lineToLoad: 'moving toward the load turns it counter-clockwise'
}

/** Elements a clause talks about: "series L", "shunt capacitor", or a bare plural meaning both kinds. */
function kindsIn(clause: string): MoveKind[] {
  const c = clause.toLowerCase()
  const kinds = new Set<MoveKind>()
  for (const m of c.matchAll(/\b(series|shunt|parallel)\s+(inductors?|capacitors?|l|c)\b/g)) {
    const shunt = m[1] !== 'series'
    const cap = m[2].startsWith('c')
    kinds.add(shunt ? (cap ? 'shuntC' : 'shuntL') : cap ? 'seriesC' : 'seriesL')
  }
  if (!kinds.size) {
    // "Capacitors move it counter-clockwise": a rule about every capacitor, series and shunt alike.
    if (/\bcapacitors\b/.test(c)) { kinds.add('seriesC'); kinds.add('shuntC') }
    if (/\binductors\b/.test(c)) { kinds.add('seriesL'); kinds.add('shuntL') }
  }
  if (/\btowards? (the )?load\b/.test(c)) kinds.add('lineToLoad')
  else if (/\btowards? (the )?generator\b|\b(transmission line|length of line|line length)\b/.test(c)) kinds.add('lineToGenerator')
  return [...kinds]
}

/** Not the tutor's own claim: negated, contrasted, or reporting what the learner said. */
const NOT_A_CLAIM = /\b(not|never|no longer|instead of|rather than|opposite|isn't|doesn't|don't|won't|wouldn't)\b|n't\b|\b(you|they) (said|chose|picked|answered|guessed|thought|predicted|wrote|went with)\b|\byour (answer|guess|prediction|pick|choice)\b|\bif (it|they|you)\b/i

export interface DirectionError { sentence: string; fix: string }

/**
 * Statements that get an element's direction wrong, e.g. "capacitors (both series and
 * shunt) move the point counter-clockwise". Checked against fixed physics, so a reply
 * can be wrong even after what_if was called, and still be caught.
 */
export function directionErrors(text: string): DirectionError[] {
  const out: DirectionError[] = []
  const sentences = text.replace(/\*\*|[()]/g, ' ').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s && !s.endsWith('?'))
  for (const sentence of sentences) {
    const clauses = sentence.split(/[,;:]|\bwhile\b|\bwhereas\b|\bbut\b|(?<!\b(?:series|shunt|parallel|both) )\band\b(?= (?:an? |the )?(?:series|shunt|parallel|inductors?|capacitors?|lines?)\b)/i)
    const wrong: MoveKind[] = []
    for (const clause of clauses) {
      if (NOT_A_CLAIM.test(clause)) continue
      const dirs = new Set([...clause.toLowerCase().matchAll(/\b(counter[- ]?clockwise|anti[- ]?clockwise|clockwise)\b/g)].map((m) => (m[1] === 'clockwise' ? 'clockwise' : 'counter-clockwise')))
      if (dirs.size !== 1) continue
      const said = [...dirs][0]
      for (const k of kindsIn(clause)) if (RULE[k] !== said && !wrong.includes(k)) wrong.push(k)
    }
    if (wrong.length) out.push({ sentence, fix: wrong.map((k) => RULE_TEXT[k]).join('; ') })
  }
  return out
}

export const directionNudge = (errs: DirectionError[]) =>
  `[System] Your last reply gets a direction wrong: ${errs.map((e) => `"${e.sentence}"`).join(' ')} ` +
  `The facts: ${errs.map((e) => e.fix).join('; ')}. (Rule of thumb: series L and shunt C turn clockwise; series C and shunt L counter-clockwise.) ` +
  'Write your reply again with this corrected; if you said it wrongly before, correct it plainly. Do not mention this check.'

/**
 * Text about the conversation's machinery instead of to the learner, e.g. (from a real
 * Gemini run, right after a correction) "This response is hidden from the learner. Retry now."
 * Never shown; the tutor is asked to reply properly.
 */
const META = /\[system\]|\b(hidden from the learner|retry now|this response is hidden|system (message|note|instruction|prompt)|do not mention this check|not the learner: don't mention|you must do this to continue|tool (call|result)s?|function call)\b/i

/**
 * The shape of the stray fragments Gemini emits after a tool call (" You must do this to
 * continue.", " You can use annotations to show it."): a leading space, short, and an
 * instruction rather than teaching. Real replies don't start with a space.
 */
const STRAY = (text: string) => /^\s/.test(text) && text.trim().length < 140 && /\b(you (must|can|should|need to)|retry|continue|proceed|respond)\b/i.test(text)

export const isMetaReply = (text: string) => META.test(text) || STRAY(text)

/**
 * A reply that is only a bracketed aside, e.g. "(I've just posted a quick question on the
 * screen!)". After a card it narrates the card instead of teaching, so it is dropped.
 */
export const isStageDirection = (text: string) => /^\s*\([^()]*\)[\s.!]*$/.test(text)

export const META_NUDGE = '[System] Your last reply was not addressed to the learner. Reply to them now, directly and in plain words, as their tutor (nothing about instructions, checks or tools).'
