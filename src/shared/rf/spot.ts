import { c, type Complex } from './complex'
import { applyElement, ELEMENT_LABEL, isShunt, type NetworkElement } from './network'
import { describeMove } from './moves'
import { solveLMatch } from './solvers'
import { eng, tc, teng, tn } from './calc'

const unit = (n: NetworkElement) => (n.kind.endsWith('L') ? 'H' : 'F')

/**
 * "Spot the mistake": a worked L-match for a load, written step by step, with one
 * realistic mistake planted (or, sometimes, none). Finding it takes understanding,
 * not recognition: every step looks plausible. The app knows where the mistake is.
 */
export const MISTAKES = ['normalise', 'direction', 'circle', 'element', 'formula', 'none'] as const
export type Mistake = (typeof MISTAKES)[number]

export interface SpotQuestion {
  /** Markdown with formulas: the worked solution, one bold "Step n." per paragraph */
  body: string
  choices: string[]
  correct: number
  /** For the tutor: where the mistake is and what's right */
  facts: string
  /** What picking "No mistake" shows they believe (when there is one) */
  missedIdea?: string
  /** What it practises: the topic the planted mistake is about */
  topic: 'read_z' | 'dir_seriesL' | 'dir_seriesC' | 'dir_shuntL' | 'dir_shuntC' | 'land_lumped' | 'l_match'
  difficulty: 1 | 2 | 3
}

const lower = (s: string) => s.replace(/^\w+/, (w) => w.toLowerCase())

export function spotQuestion(ZL: Complex, z0: number, f: number, mistake: Mistake): SpotQuestion {
  const sols = solveLMatch(ZL, z0, f).filter((s) => s.elements.length === 2)
  if (!sols.length) throw new Error('This load needs fewer than two elements to match (or none): pick another load for a worked two-element match.')
  const sol = sols[0]
  const w = 2 * Math.PI * f
  const els: NetworkElement[] = sol.elements.map((e, i) => ({ id: `s${i}`, kind: e.kind, value: e.value }))
  const Z1 = applyElement(ZL, els[0], f)
  const zL = c(ZL.re / z0, ZL.im / z0)
  const z1 = c(Z1.re / z0, Z1.im / z0)
  const m1 = describeMove(ZL, els[0], f, z0)
  const m2 = describeMove(Z1, els[1], f, z0)
  const name = (i: number) => ELEMENT_LABEL[els[i].kind]

  // Step 1: normalise
  const step1 = mistake === 'normalise'
    ? `$z_L = \\dfrac{Z_0}{Z_L} = \\dfrac{${tn(z0)}}{${tc(ZL)}} = ${tc(divC(c(1, 0), zL))}$`
    : `$z_L = \\dfrac{Z_L}{Z_0} = \\dfrac{${tc(ZL)}}{${tn(z0)}} = ${tc(zL)}$`

  // Steps 2 and 3: the two moves
  const moveText = (i: number, m: ReturnType<typeof describeMove>, to: string, wrong: Mistake | null) => {
    const shunt = isShunt(els[i].kind)
    const adds = shunt ? (m.rotation === 'clockwise' ? '+jb' : '-jb') : (m.rotation === 'clockwise' ? '+jx' : '-jx')
    const rot = wrong === 'direction' ? (m.rotation === 'clockwise' ? 'counter-clockwise' : 'clockwise') : m.rotation
    const circle = (wrong === 'circle' ? !shunt : shunt) ? 'constant-$g$' : 'constant-$r$'
    // The wrong part for that sign: an L where a C is needed, or the other way round.
    const swapped = { seriesL: 'Series C', seriesC: 'Series L', shuntL: 'Shunt C', shuntC: 'Shunt L' } as Record<string, string>
    const part = wrong === 'element' ? swapped[els[i].kind] ?? name(i) : name(i)
    return `A ${lower(part)} adds $${adds}$, so the point turns ${rot} along its ${circle} circle to ${to}.`
  }
  const step2 = moveText(0, m1, `$z_1 = ${tc(z1)}$`, mistake === 'direction' || mistake === 'circle' || mistake === 'element' ? mistake : null)
  const step3 = moveText(1, m2, 'the centre, $z = 1$', null)

  // Step 4: the values. The planted slip is the classic one: ω taken as f (2π forgotten). The
  // formula looks right and the value is plausible; only checking the number finds it.
  const valueTex = (i: number, wrong: boolean) => {
    const e = sol.elements[i]
    const k = els[i].kind
    const wv = wrong ? f : w
    if (k === 'seriesL') {
      const X = e.reactanceOhm!
      return `$L = \\dfrac{X}{\\omega} = \\dfrac{${tn(X)}}{${tn(wv, 4)}} = ${teng(X / wv, 'H')}$`
    }
    if (k === 'seriesC') {
      const X = Math.abs(e.reactanceOhm!)
      return `$C = \\dfrac{1}{\\omega |X|} = \\dfrac{1}{${tn(wv, 4)}\\cdot ${tn(X)}} = ${teng(1 / (wv * X), 'F')}$`
    }
    if (k === 'shuntC') {
      const B = e.susceptanceS!
      return `$C = \\dfrac{B}{\\omega} = \\dfrac{${tn(B)}}{${tn(wv, 4)}} = ${teng(B / wv, 'F')}$`
    }
    const B = Math.abs(e.susceptanceS!)
    return `$L = \\dfrac{1}{\\omega |B|} = \\dfrac{1}{${tn(wv, 4)}\\cdot ${tn(B)}} = ${teng(1 / (wv * B), 'H')}$`
  }
  const step4 = `${name(0)}: ${valueTex(0, mistake === 'formula')}; ${lower(name(1))}: ${valueTex(1, false)}.`

  const body = [
    `A worked match for $Z_L = ${tc(ZL)}\\,\\Omega$ to $Z_0 = ${tn(z0)}\\,\\Omega$ at $${teng(f, 'Hz', 4)}$. Is there a mistake? If so, where?`,
    `**Step 1.** ${step1}`,
    `**Step 2.** ${step2}`,
    `**Step 3.** ${step3}`,
    `**Step 4.** ${step4}`
  ].join('\n\n')

  const choices = ['Step 1', 'Step 2', 'Step 3', 'Step 4', "No mistake: it's all right"]
  const where = { normalise: 0, direction: 1, circle: 1, element: 1, formula: 3, none: 4 }[mistake]
  const truth: Record<Mistake, string> = {
    normalise: `Step 1 inverts the normalisation: z = Z/Z0 = ${fmt(zL)}, not Z0/Z.`,
    direction: `Step 2 has the direction wrong: a ${lower(name(0))} turns the point ${m1.rotation}.`,
    circle: `Step 2 names the wrong circle: a ${isShunt(els[0].kind) ? 'shunt part keeps g fixed (constant-g circle)' : 'series part keeps r fixed (constant-r circle)'}.`,
    element: `Step 2 uses the wrong part: that sign of ${isShunt(els[0].kind) ? 'susceptance' : 'reactance'} needs a ${lower(name(0))}.`,
    formula: `Step 4 uses f where ω = 2πf belongs (2π forgotten), so the ${lower(name(0))} is off by 2π: the right value is ${eng(sol.elements[0].value, unit(els[0]))}.`,
    none: 'There is no mistake: every step is right.'
  }
  const missed: Partial<Record<Mistake, string>> = {
    normalise: 'Accepts z = Z0/Z as the normalised impedance',
    direction: `Accepts that a ${lower(name(0))} turns the point ${m1.rotation === 'clockwise' ? 'counter-clockwise' : 'clockwise'}`,
    circle: `Accepts that a ${isShunt(els[0].kind) ? 'shunt part moves along a constant-r circle' : 'series part moves along a constant-g circle'}`,
    element: `Accepts the wrong part type for the sign of ${isShunt(els[0].kind) ? 'susceptance' : 'reactance'}`,
    formula: 'Accepts ω = f (forgets the 2π) when working out a component value'
  }
  const topic: SpotQuestion['topic'] =
    mistake === 'normalise' ? 'read_z'
    : mistake === 'direction' ? (`dir_${els[0].kind}` as SpotQuestion['topic'])
    : mistake === 'circle' ? 'land_lumped'
    : 'l_match'
  const difficulty = mistake === 'normalise' ? 1 : mistake === 'formula' || mistake === 'none' ? 3 : 2
  return {
    body, choices, correct: where,
    facts: `${truth[mistake]} The worked solution (${sol.description}): ${name(0)} ${eng(sol.elements[0].value, unit(els[0]))} then ${name(1)} ${eng(sol.elements[1].value, unit(els[1]))}; z goes ${fmt(zL)} → ${fmt(z1)} → 1.`,
    missedIdea: missed[mistake], topic, difficulty
  }
}

const fmt = (z: Complex) => `${Math.round(z.re * 100) / 100} ${z.im < 0 ? '−' : '+'} j${Math.round(Math.abs(z.im) * 100) / 100}`
function divC(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}
