import { SKILLS, skillName, type Profile, type SkillId } from './profile'
import { ladderOf, LADDER_SKILLS, rungsFor, rungWords, type Rung } from './ladder'
import { READING_SKILLS, readingOf } from './reading'
import { loadImpedance, type Dataset, type LoadModel } from './rf/network'
import { metricsFromZ } from './rf/metrics'
import { solveLMatch } from './rf/solvers'

/**
 * The learner's project (capstone): one concrete task tied to their goal, e.g. "match your 2.4 GHz
 * antenna across 2.40–2.48 GHz to VSWR ≤ 2". It is described by its settings, never picked from a
 * list of types: what to match, where (a frequency or a band), how well (VSWR) and with what parts.
 * The route to it is worked out from those settings by the app (routeOf): the skills it needs, each
 * with the independence-ladder rung (ladder.ts) or reading stage (reading.ts) it takes. No new scoring.
 *
 * The tutor proposes it from their goal (set_capstone); the learner can change any setting on Progress.
 * When every milestone is met the final task opens: a graded match on the project's own load, band,
 * VSWR and parts (create_exercise with capstone: true). A "judge" project (interview prep) has no
 * build: it is done when they can judge worked matches (L-matching at the judge rung).
 */
export type CapstoneLoad = Exclude<LoadModel, { kind: 'data' }> | { kind: 'data'; datasetName: string }
export type CapstoneParts = 'lumped' | 'lines' | 'any'

export interface Capstone {
  load: CapstoneLoad
  f0: number
  band?: { low: number; high: number }
  maxVswr: number
  parts: CapstoneParts
  /** The system impedance it was set under (the final task uses it, so the target can't be eased by another Z0) */
  z0: number
  /** No build: the project is judging worked matches (spot the mistake), e.g. for interview prep */
  judge?: boolean
  /** Why this project, to the learner (from the tutor, or their own words) */
  why?: string
  setBy: 'tutor' | 'learner'
  at: string
  done?: { at: string; session?: string }
}

export type Need = { kind: 'rung'; rung: Rung } | { kind: 'chart' }
export interface Milestone { skill: SkillId; need: Need; met: boolean; words: string }

/**
 * A project from its settings, checked: the same rules for the tutor's set_capstone and the learner's
 * form on Progress. Throws with a reason the tutor (or the form) can act on.
 */
export function makeCapstone(x: { load: CapstoneLoad; f0: number; band?: { low: number; high: number }; maxVswr: number; parts?: CapstoneParts; z0?: number; judge?: boolean; why?: string; setBy: Capstone['setBy']; at: string }): Capstone {
  if (!(x.f0 >= 1e6 && x.f0 <= 1e11)) throw new Error('The project frequency must be between 1 MHz and 100 GHz.')
  if (x.band) {
    const { low, high } = x.band
    if (!(low > 0 && high > low)) throw new Error('The band needs a low edge below its high edge.')
    if (x.f0 < low || x.f0 > high) throw new Error(`The frequency (${fmtF(x.f0)}) must sit inside the band (${fmtF(low)}–${fmtF(high)}).`)
    if (high / low > 2) throw new Error('That band is wider than an octave: too wide for a matching project here. Narrow it.')
  }
  if (!(x.maxVswr >= 1.05 && x.maxVswr <= 5)) throw new Error('The VSWR target must be between 1.05 and 5 (2 is usual for a band, 1.5 or tighter at one frequency).')
  const why = x.why?.trim().slice(0, 200)
  return {
    load: x.load, f0: x.f0, ...(x.band ? { band: x.band } : {}), maxVswr: Math.round(x.maxVswr * 100) / 100,
    parts: x.parts ?? 'any', z0: x.z0 && x.z0 > 0 ? x.z0 : 50, ...(x.judge ? { judge: true } : {}), ...(why ? { why } : {}), setBy: x.setBy, at: x.at
  }
}

/** The load's Q near f: ω|dZ/dω| / 2R (Yaghjian–Best), from a small step either side; for data, from its own points. */
export function loadQ(load: LoadModel, f: number, datasets: Dataset[]): number {
  const df = load.kind === 'data' ? Math.max(f * 1e-3, ...(() => { const d = datasets.find((x) => x.id === load.datasetId); return d && d.freqs.length > 1 ? [(d.freqs[d.freqs.length - 1] - d.freqs[0]) / (d.freqs.length - 1)] : [] })()) : f * 1e-4
  const a = loadImpedance(load, f - df, datasets), b = loadImpedance(load, f + df, datasets), z = loadImpedance(load, f, datasets)
  const dZ = Math.hypot(b.re - a.re, b.im - a.im) / (2 * df)
  return z.re > 0 ? (f * dZ) / (2 * z.re) : Infinity
}

const fmtF = (hz: number) => (hz >= 1e9 ? `${+(hz / 1e9).toFixed(3)} GHz` : `${+(hz / 1e6).toFixed(1)} MHz`)

/** The project in one line, from its settings (so a change to any setting changes the title). */
export function titleOf(c: Capstone): string {
  if (c.judge) return 'Judge worked L-matches like an interviewer: find the mistake, or show there is none'
  const l = c.load
  const what = l.kind === 'data' ? `your ${l.datasetName} data`
    : l.kind === 'antenna' ? `a ${fmtF(l.f0)} ${l.topology === 'parallel' ? 'patch-like' : 'dipole-like'} antenna`
      : l.kind === 'fixed' ? `${+l.R.toFixed(1)} ${l.X < 0 ? '−' : '+'} j${+Math.abs(l.X).toFixed(1)} Ω`
        : 'an RLC load'
  const where = c.band ? `across ${fmtF(c.band.low)}–${fmtF(c.band.high)}` : `at ${fmtF(c.f0)}`
  const parts = c.parts === 'lines' ? ' with a line and a stub' : c.parts === 'lumped' ? ' with L and C parts' : ''
  return `Match ${what} ${where} to VSWR ≤ ${c.maxVswr}${parts}`
}

/**
 * A tight target makes the match "constrained" on the ladder; otherwise planning it is enough. Not a
 * band: band items count toward Q & bandwidth (classifyMatch), which a band project needs anyway.
 */
const tight = (c: Capstone) => c.maxVswr <= 1.2

/** The project's load as the chart uses it, or null when its data isn't loaded. */
export function projectLoad(c: Capstone, datasets: Dataset[]): LoadModel | null {
  if (c.load.kind !== 'data') return c.load
  const name = c.load.datasetName
  const ds = datasets.find((d) => d.name === name)
  return ds ? { kind: 'data', datasetId: ds.id } : null
}

/**
 * Why a project can't work, or null: data that doesn't cover its frequencies, a load that already
 * meets the target everywhere it's judged (nothing to match), or, for L and C at one frequency, no
 * L-match with practical part values. Checked when it's set (tutor or learner) and again at the final
 * task, so an impossible project never waits at the end of a finished route.
 */
export function capstoneProblem(c: Capstone, datasets: Dataset[]): string | null {
  if (c.judge) return null
  const z0 = c.z0 ?? 50
  const load = projectLoad(c, datasets)
  if (!load) return `its data "${(c.load as { datasetName: string }).datasetName}" isn't loaded: import it again (Load panel)`
  const fs = c.band ? Array.from({ length: 41 }, (_, i) => c.band!.low + ((c.band!.high - c.band!.low) * i) / 40) : [c.f0]
  if (load.kind === 'data') {
    const ds = datasets.find((d) => d.id === load.datasetId)!
    const lo = ds.freqs[0], hi = ds.freqs[ds.freqs.length - 1]
    if (fs.some((f) => f < lo || f > hi)) return `its data covers ${fmtF(lo)}–${fmtF(hi)}, which doesn't include ${c.band ? 'the whole band' : fmtF(c.f0)}`
  }
  const worst = Math.max(...fs.map((f) => metricsFromZ(loadImpedance(load, f, datasets), z0).vswr))
  if (worst <= c.maxVswr) return `the load already meets VSWR ≤ ${c.maxVswr} ${c.band ? 'across the band' : 'there'} (worst ${worst.toFixed(2)}), so there's nothing to match: make the target tighter${c.band ? '' : ' or add a band'}`
  // Across a band: no network of any size beats the Bode–Fano limit, BW/f0 ≤ π / (Q ln(1/|Γ|max)), with
  // the load's Q from how fast its impedance turns with frequency (Q ≈ ω|dZ/dω| / 2R). A project past it
  // could never be passed, however far the learner gets.
  if (c.band) {
    const q = loadQ(load, c.f0, datasets)
    const gMax = (c.maxVswr - 1) / (c.maxVswr + 1)
    const limit = Math.PI / (q * Math.log(1 / gMax))
    const want = (c.band.high - c.band.low) / c.f0
    if (Number.isFinite(limit) && want > limit) return `the band is wider than any matching network can reach for this load (its Q is about ${q.toFixed(0)}: at most ${(limit * 100).toFixed(1)}% of ${fmtF(c.f0)} at VSWR ≤ ${c.maxVswr}, and the band is ${(want * 100).toFixed(1)}%): narrow the band or relax the VSWR`
  }
  if (c.parts === 'lumped' && !c.band) {
    const ok = solveLMatch(loadImpedance(load, c.f0, datasets), z0, c.f0).some((s) => s.elements.every((e) => (e.kind.endsWith('L') ? e.value >= 0.05e-9 && e.value <= 500e-9 : e.value >= 0.01e-12 && e.value <= 500e-12)))
    if (!ok) return `no L-match with practical parts (0.05–500 nH, 0.01–500 pF) exists for it at ${fmtF(c.f0)}: allow lines and stubs, or pick another frequency`
  }
  return null
}

/**
 * The milestones, from the settings: reading the chart (VSWR and z, then y for shunt work), the
 * skills of the kind of match, a band's Q & bandwidth, then every prerequisite (at "one choice", or
 * reading from the chart), in the order the skills build on each other.
 */
export function routeOf(c: Capstone): Array<{ skill: SkillId; need: Need }> {
  const m = new Map<SkillId, Need>()
  const rung = (skill: SkillId, r: Rung) => m.set(skill, { kind: 'rung', rung: r })
  m.set('chart_basics', { kind: 'chart' })
  m.set('reflection', { kind: 'chart' })
  m.set('admittance', { kind: 'chart' })
  if (c.judge) { rung('lumped_moves', 2); rung('l_match', 5) }
  // Lines: an unguided line + stub match is a stubs item; tlines rung 3 would take a line-only match, so 2.
  else if (c.parts === 'lines') { rung('tlines', 2); rung('stubs', tight(c) ? 4 : 3) }
  else { rung('lumped_moves', 2); rung('l_match', tight(c) ? 4 : 3) }
  if (c.band && !c.judge) rung('q_bandwidth', 4)
  // Whatever those build on, at the first step that shows they can use it.
  const add = (s: SkillId) => {
    for (const pre of SKILLS.find((x) => x.id === s)?.prerequisites ?? []) {
      if (!m.has(pre)) {
        if (LADDER_SKILLS.includes(pre)) rung(pre, 2)
        else if (READING_SKILLS.includes(pre)) m.set(pre, { kind: 'chart' })
      }
      add(pre)
    }
  }
  // A band project with lines needs band items (Q & bandwidth), not L-matching, whatever Q & bandwidth builds on.
  for (const s of [...m.keys()]) if (!(c.parts === 'lines' && s === 'q_bandwidth')) add(s)
  return SKILLS.map((s) => s.id).filter((id) => m.has(id)).map((skill) => ({ skill, need: m.get(skill)! }))
}

/** Met: confirmed by their answers (an estimate from related skills or old records doesn't count yet). */
function met(p: Profile, skill: SkillId, need: Need): boolean {
  if (need.kind === 'chart') { const r = readingOf(p, skill); return r.stage === 'chart' && !r.provisional }
  const st = p.ladder?.[skill]
  return !!st && !st.provisional && st.rung >= need.rung
}

const needWords = (skill: SkillId, need: Need) => `${skillName(skill)}: ${need.kind === 'chart' ? 'reading values from the chart yourself' : rungWords(need.rung)}`

export function milestones(p: Profile, c: Capstone): Milestone[] {
  return routeOf(c).map(({ skill, need }) => ({ skill, need, met: met(p, skill, need), words: needWords(skill, need) }))
}

export type CapstoneStage = 'route' | 'final' | 'done'
export const stageOf = (p: Profile, c: Capstone): CapstoneStage =>
  c.done ? 'done' : milestones(p, c).every((x) => x.met) ? (c.judge ? 'done' : 'final') : 'route'

/** The step after where they are on a milestone: the next rung up on that skill, or reading from the chart. */
function nextStepOn(p: Profile, skill: SkillId, need: Need): string {
  if (need.kind === 'chart') return `${skillName(skill)}: reading values from the chart yourself`
  const now = ladderOf(p, skill)
  const up = rungsFor(skill).find((r) => r > now.rung && r <= need.rung) ?? need.rung
  return `${skillName(skill)}: ${rungWords(up)}`
}

/** The next step up on a skill, from where it stands (an estimate too, so a skill not yet on the ladder has one). */
function nextUp(p: Profile, skill: SkillId): string | null {
  if (LADDER_SKILLS.includes(skill)) {
    const up = rungsFor(skill).find((r) => r > ladderOf(p, skill).rung)
    return up ? `${skillName(skill)}: ${rungWords(up)}` : null
  }
  if (READING_SKILLS.includes(skill) && readingOf(p, skill).stage === 'readout') return `${skillName(skill)}: reading values from the chart yourself`
  return null
}

/**
 * "Up next" for the end of a lesson and the launcher: the next step toward their project, the final
 * task once it's open, or (no project) the next step up on the first skill of the tutor's plan.
 */
export function upNext(p: Profile): string | null {
  const c = p.capstone
  const stage = c ? stageOf(p, c) : null
  if (c && stage === 'final') return `Your project's final task is open: ${titleOf(c)}.`
  if (c && stage === 'route') {
    const next = milestones(p, c).find((x) => !x.met)!
    return `Next step toward your project: ${nextStepOn(p, next.skill, next.need)}.`
  }
  // No project, or it's done: the next step up on what the tutor planned.
  const skill = p.nextFocus?.picks[0]?.skill
  const step = skill ? nextUp(p, skill) : null
  return step ? `Next: ${step}.` : null
}

/**
 * Which items move a milestone, where it isn't obvious: a match counts toward stubs only with a stub in
 * allowed_kinds (otherwise it's an L-match), a band item toward Q & bandwidth, judging only by spot-the-mistake.
 */
const HOW_TO_MOVE: Partial<Record<SkillId, string>> = {
  stubs: 'create_exercise with a stub (openStub / shortStub) in allowed_kinds, parts not named',
  tlines: 'ask_move a line with its reason, or a task with a line',
  q_bandwidth: 'a match graded across a band (band_low_hz / band_high_hz)',
  l_match: 'create_exercise with a load and a VSWR goal, parts not named; for judging, ask_spot_error'
}
function nextMilestoneLine(x: Milestone): string {
  const how = x.need.kind === 'rung' ? HOW_TO_MOVE[x.skill] : 'a reading question (ask_value / ask_locate) with the values covered'
  return `Next milestone: ${x.words}${how ? ` (items that move it: ${how})` : ''}. Prefer work that moves it (set_next_focus too).`
}

/** For the tutor's brief: the project, where they are on the route, and what to do about it. */
export function capstoneBrief(p: Profile): string {
  const c = p.capstone
  if (!c) return 'Project (capstone): none yet. Propose one from their goals with set_capstone (what to match, where, how well, with what parts), then plan toward it.'
  const stage = stageOf(p, c)
  const ms = milestones(p, c)
  const route = ms.map((x) => `${x.met ? '✓' : '·'} ${x.skill} ${x.need.kind === 'chart' ? 'from the chart' : `rung ${x.need.rung}`}`).join('; ')
  const doing = stage === 'done' ? (c.done ? 'DONE: congratulate them when it fits, and propose the next, harder project with set_capstone (tighter VSWR, a band, lines and stubs, their own data).' : 'DONE (judge project): propose the next project with set_capstone.')
    : stage === 'final' ? 'All milestones met: set the final task now or soon (create_exercise with capstone: true; the app fills in the load, band, VSWR and parts). If its card is already open, leave it: they are working on it.'
      : nextMilestoneLine(ms.find((x) => !x.met)!)
  return `Project (capstone, set by ${c.setBy === 'learner' ? 'the learner: change it only if they ask' : 'you'}): "${titleOf(c)}". Route: ${route}. ${doing}`
}
