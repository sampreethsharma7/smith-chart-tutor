import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { c } from './complex'
import { applyElement, inputImpedance, type NetworkElement } from './network'
import { gammaFromZ, metricsFromZ } from './metrics'
import { componentFor, componentForMove, convert, networkSteps, parseCalcComplex, tc, teng, type Step } from './calc'

const F = 2.4e9
const Z0 = 50
const w = 2 * Math.PI * F

/** Every formula must be valid TeX: KaTeX in strict mode throws on anything malformed. */
const renders = (steps: Step[]) => steps.forEach((s) => expect(() => katex.renderToString(s.tex, { throwOnError: true }), `${s.label}: ${s.tex}`).not.toThrow())
const out = (r: { outputs: Array<{ label: string; text: string }> }, label: string) => r.outputs.find((o) => o.label === label)?.text

describe('TeX formatting', () => {
  it('writes complex numbers the way a person would', () => {
    expect(tc(c(0.6, 0.4))).toBe('0.6 + j0.4')
    expect(tc(c(0.6, -0.4))).toBe('0.6 - j0.4')
    expect(tc(c(0.6, 0))).toBe('0.6')
    expect(tc(c(0, -1.2))).toBe('-j1.2')
    expect(teng(2.65e-9, 'H')).toBe('2.65\\,\\text{n}\\text{H}')
    expect(teng(4.2e-6, 'H')).toBe('4.2\\,\\mu\\text{H}')
  })
  it('reads polar and rectangular entries', () => {
    const g = parseCalcComplex('0.5∠90°')!
    expect(g.re).toBeCloseTo(0)
    expect(g.im).toBeCloseTo(0.5)
    expect(parseCalcComplex('0.5<-90')!.im).toBeCloseTo(-0.5)
    expect(parseCalcComplex('30 + j20')).toEqual(c(30, 20))
    expect(parseCalcComplex('nonsense')).toBeNull()
  })
})

describe('converter', () => {
  const m = metricsFromZ(c(30, 20), Z0)
  it('gives the same answer from any starting form', () => {
    for (const [from, v] of [['Z', c(30, 20)], ['z', c(0.6, 0.4)], ['y', m.y], ['Y', m.Y], ['gamma', m.gamma]] as const) {
      const r = convert(from, v, Z0)
      expect(out(r, 'z'), from).toBe('0.6 + j0.4')
      expect(out(r, 'VSWR'), from).toBe(String(Number(m.vswr.toPrecision(3))))
      expect(r.warning).toBeUndefined()
      renders(r.steps)
    }
  })
  it('shows the working with the numbers put in', () => {
    const r = convert('Z', c(30, 20), Z0)
    expect(r.steps.map((s) => s.label)).toEqual(['Normalise', 'Admittance', 'In siemens', 'Reflection', 'VSWR', 'Return loss', 'Node Q'])
    expect(r.steps[0].tex).toContain('\\frac{30 + j20}{50} = 0.6 + j0.4')
  })
  it('handles the edges: open, short, matched, outside the chart', () => {
    expect(convert('gamma', c(1, 0), Z0).warning).toMatch(/open circuit/)
    const short = convert('z', c(0, 0), Z0)
    expect(out(short, 'VSWR')).toBe('∞')
    renders(short.steps)
    const matched = convert('z', c(1, 0), Z0)
    expect(out(matched, 'VSWR')).toBe('1')
    renders(matched.steps)
    expect(convert('z', c(-0.5, 0.2), Z0).warning).toMatch(/outside the chart/)
  })
})

describe('reactance → component', () => {
  it('series: +x is an inductor, −x a capacitor, and the part really adds that x', () => {
    const L = componentFor('series', 0.8, true, F, Z0)
    expect(L.component!.kind).toBe('seriesL')
    expect(L.component!.value).toBeCloseTo((0.8 * Z0) / w, 15)
    const z = applyElement(c(30, 20), { id: 'a', kind: 'seriesL', value: L.component!.value }, F)
    expect(z.im).toBeCloseTo(20 + 40, 9)
    const C = componentFor('series', -40, false, F, Z0)
    expect(C.component!.kind).toBe('seriesC')
    expect(applyElement(c(30, 20), { id: 'b', kind: 'seriesC', value: C.component!.value }, F).im).toBeCloseTo(-20, 9)
    renders(L.steps)
    renders(C.steps)
  })
  it('shunt: +b is a capacitor, −b an inductor, and the part really adds that b', () => {
    const y0 = metricsFromZ(c(30, 20), Z0).y
    for (const b of [0.5, -0.7]) {
      const r = componentFor('shunt', b, true, F, Z0)
      expect(r.component!.kind).toBe(b > 0 ? 'shuntC' : 'shuntL')
      const y1 = metricsFromZ(applyElement(c(30, 20), { id: 'x', ...r.component! }, F), Z0).y
      expect(y1.im - y0.im).toBeCloseTo(b, 9)
      renders(r.steps)
    }
  })
  it('from → to: finds the part for a real matching step', () => {
    // z = 0.6 + j0.4 → shunt part onto the r = 1 circle's admittance twin… use a known L-match step:
    const zA = c(0.2, 0.5), yA = { re: 0.2 / (0.04 + 0.25), im: -0.5 / (0.04 + 0.25) }
    // keep g, set b so that the point lands on r = 1 after the shunt part (g = yA.re).
    const g = yA.re, bTarget = Math.sqrt(g * (1 - g))
    const yB = c(g, bTarget)
    const zB = { re: yB.re / (yB.re ** 2 + yB.im ** 2), im: -yB.im / (yB.re ** 2 + yB.im ** 2) }
    expect(zB.re).toBeCloseTo(1, 9)
    const r = componentForMove('shunt', zA, zB, F, Z0)
    expect(r.warning).toBeUndefined()
    const after = applyElement(scaleZ(zA), { id: 's', ...r.component! }, F)
    expect(after.re / Z0).toBeCloseTo(1, 6)
    expect(after.im / Z0).toBeCloseTo(zB.im, 6)
    renders(r.steps)
  })
  it('from → to: warns when one part of that kind can\'t make the move', () => {
    expect(componentForMove('series', c(0.6, 0.4), c(1, 0), F, Z0).warning).toMatch(/keeps r fixed/)
    expect(componentForMove('shunt', c(1, 1), c(1, 0), F, Z0).warning).toMatch(/keeps g fixed/)
    expect(componentForMove('series', c(1, 0.4), c(1, -0.2), F, Z0).warning).toBeUndefined()
  })
})

const scaleZ = (z: { re: number; im: number }) => c(z.re * Z0, z.im * Z0)

describe('network step by step', () => {
  const ZL = c(30, 20)
  const all: NetworkElement[] = [
    { id: '1', kind: 'seriesC', value: 8e-12 },
    { id: '2', kind: 'shuntL', value: 6e-9 },
    { id: '3', kind: 'seriesL', value: 1e-9 },
    { id: '4', kind: 'shuntC', value: 0.5e-12 },
    { id: '5', kind: 'tline', value: 30, zc: 50, refHz: F },
    { id: '6', kind: 'tline', value: 20, zc: 75, refHz: F },
    { id: '7', kind: 'openStub', value: 15, zc: 50, refHz: F },
    { id: '8', kind: 'shortStub', value: 70, zc: 50, refHz: F },
    { id: '9', kind: 'seriesR', value: 5 },
    { id: '10', kind: 'shuntR', value: 500 }
  ]
  const rows = networkSteps(ZL, all, F, Z0)

  it('agrees with the chart engine at every node', () => {
    let Z = ZL
    rows.forEach((row, i) => {
      Z = applyElement(Z, all[i], F)
      expect(row.zAfter.re).toBeCloseTo(Z.re / Z0, 9)
      expect(row.zAfter.im).toBeCloseTo(Z.im / Z0, 9)
    })
    const zin = inputImpedance(ZL, all, F)
    expect(rows.at(-1)!.zAfter.re).toBeCloseTo(zin.re / Z0, 9)
  })
  it('every kind of element gets working that renders', () => {
    for (const r of rows) {
      expect(r.steps.length, r.title).toBeGreaterThan(0)
      renders(r.steps)
    }
    expect(rows[0].steps.at(-1)!.tex).toMatch(/^z_\{1\} = z_L \+ jx/)
    expect(rows.at(-1)!.steps.at(-1)!.tex).toMatch(/^z_\{in\} = /)
  })
  it('a matched line keeps |Γ| and rotates by 2βℓ', () => {
    const line = networkSteps(ZL, [{ id: 'l', kind: 'tline', value: 45, zc: 50, refHz: F }], F, Z0)[0]
    const g1 = gammaFromZ(line.zBefore, 1), g2 = gammaFromZ(line.zAfter, 1)
    expect(Math.hypot(g2.re, g2.im)).toBeCloseTo(Math.hypot(g1.re, g1.im), 9)
    expect(line.steps.at(-1)!.label).toBe('On the chart')
  })
})
