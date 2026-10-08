/** Minimal immutable complex-number helpers used by the whole RF engine. */
export interface Complex {
  re: number
  im: number
}

export const c = (re: number, im = 0): Complex => ({ re, im })
export const ZERO = c(0, 0)
export const ONE = c(1, 0)

export const add = (a: Complex, b: Complex): Complex => c(a.re + b.re, a.im + b.im)
export const sub = (a: Complex, b: Complex): Complex => c(a.re - b.re, a.im - b.im)
export const mul = (a: Complex, b: Complex): Complex =>
  c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
export const scale = (a: Complex, k: number): Complex => c(a.re * k, a.im * k)

export function div(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im
  if (d === 0) return c(a.re === 0 ? 0 : Infinity, a.im === 0 ? 0 : Infinity)
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}

export const inv = (a: Complex): Complex => div(ONE, a)
export const abs = (a: Complex): number => Math.hypot(a.re, a.im)
export const arg = (a: Complex): number => Math.atan2(a.im, a.re)
export const conj = (a: Complex): Complex => c(a.re, -a.im)
export const polar = (mag: number, rad: number): Complex => c(mag * Math.cos(rad), mag * Math.sin(rad))
export const isFiniteC = (a: Complex): boolean => Number.isFinite(a.re) && Number.isFinite(a.im)

export const deg = (rad: number): number => (rad * 180) / Math.PI
export const rad = (d: number): number => (d * Math.PI) / 180

/** Linear interpolation between two complex values. */
export const lerp = (a: Complex, b: Complex, t: number): Complex =>
  c(a.re + (b.re - a.re) * t, a.im + (b.im - a.im) * t)
