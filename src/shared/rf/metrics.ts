import { Complex, abs, add, arg, c, deg, div, inv, isFiniteC, ONE, scale, sub } from './complex'

/** Γ = (Z − Z0) / (Z + Z0) */
export function gammaFromZ(z: Complex, z0: number): Complex {
  if (!isFiniteC(z)) return ONE // open circuit
  return div(sub(z, c(z0)), add(z, c(z0)))
}

/** Z = Z0 (1 + Γ) / (1 − Γ) */
export function zFromGamma(g: Complex, z0: number): Complex {
  return scale(div(add(ONE, g), sub(ONE, g)), z0)
}

export interface PointMetrics {
  /** Impedance in ohms */
  Z: Complex
  /** Normalized impedance z = Z / Z0 */
  z: Complex
  /** Admittance in siemens */
  Y: Complex
  /** Normalized admittance y = Y · Z0 */
  y: Complex
  gamma: Complex
  gammaMag: number
  gammaDeg: number
  vswr: number
  /** Return loss in dB (positive number = better match) */
  returnLossDb: number
  /** Power lost to reflection, dB */
  mismatchLossDb: number
  /** Fraction of incident power delivered to the load */
  powerDelivered: number
  /** Node Q = |X| / R */
  q: number
  /** Distance in wavelengths toward generator (WTG scale on a paper Smith chart) */
  wtg: number
  /** Distance in wavelengths toward load */
  wtl: number
  /** Equivalent series component at the given frequency (if provided) */
  seriesEquivalent?: { kind: 'L' | 'C' | 'none'; value: number }
  /** Equivalent shunt component at the given frequency (if provided) */
  shuntEquivalent?: { kind: 'L' | 'C' | 'none'; value: number }
}

function equivalent(reactance: number, w: number): { kind: 'L' | 'C' | 'none'; value: number } {
  if (!Number.isFinite(reactance) || Math.abs(reactance) < 1e-12) return { kind: 'none', value: 0 }
  return reactance > 0 ? { kind: 'L', value: reactance / w } : { kind: 'C', value: -1 / (w * reactance) }
}

export function metricsFromGamma(g: Complex, z0: number, freqHz?: number): PointMetrics {
  const gammaMag = abs(g)
  const Z = zFromGamma(g, z0)
  const Y = inv(Z)
  const z = scale(Z, 1 / z0)
  const y = scale(Y, z0)
  const gammaDegVal = deg(arg(g))
  const vswr = gammaMag >= 1 ? Infinity : (1 + gammaMag) / (1 - gammaMag)
  const returnLossDb = gammaMag === 0 ? Infinity : -20 * Math.log10(gammaMag)
  const powerDelivered = Math.max(0, 1 - gammaMag * gammaMag)
  const mismatchLossDb = powerDelivered === 0 ? Infinity : -10 * Math.log10(powerDelivered)
  const q = Z.re === 0 ? Infinity : Math.abs(Z.im) / Math.abs(Z.re)
  // WTG: 0 at the short-circuit point (Γ angle 180°), increasing clockwise, period 0.5 λ.
  let wtg = ((180 - gammaDegVal) / 720) % 0.5
  if (wtg < 0) wtg += 0.5
  const wtl = (0.5 - wtg) % 0.5

  const m: PointMetrics = {
    Z, z, Y, y, gamma: g, gammaMag, gammaDeg: gammaDegVal, vswr,
    returnLossDb, mismatchLossDb, powerDelivered, q, wtg, wtl
  }
  if (freqHz && freqHz > 0) {
    const w = 2 * Math.PI * freqHz
    m.seriesEquivalent = equivalent(Z.im, w)
    // Shunt: B > 0 is capacitive, so pass −1/B as an "equivalent reactance".
    m.shuntEquivalent = Y.im === 0 ? { kind: 'none', value: 0 } : equivalent(-1 / Y.im, w)
  }
  return m
}

export function metricsFromZ(Z: Complex, z0: number, freqHz?: number): PointMetrics {
  return metricsFromGamma(gammaFromZ(Z, z0), z0, freqHz)
}

/** Re-reference a reflection coefficient from one reference impedance to another. */
export function renormalize(g: Complex, fromZ0: number, toZ0: number): Complex {
  if (fromZ0 === toZ0) return g
  return gammaFromZ(zFromGamma(g, fromZ0), toZ0)
}

export const vswrToGamma = (vswr: number): number => (vswr - 1) / (vswr + 1)
