import { describe, expect, it } from 'vitest'
import { c } from './complex'
import { describeMove, screenMove } from './moves'
import { pointNamedIn } from './tasks'

const z = (...values: Array<[number, number]>) => ({ via: 'z', values: values.map(([a, b]) => c(a, b)) })
const y = (...values: Array<[number, number]>) => ({ via: 'y', values: values.map(([a, b]) => c(a, b)) })

describe('the point a card names (filing click questions by what the learner reads)', () => {
  it('reads z or y with its value, in the forms models write', () => {
    expect(pointNamedIn('Click z = 0.5 + j1 on the chart.')).toEqual(z([0.5, 1]))
    expect(pointNamedIn('Where is y = 1 − j1?')).toEqual(y([1, -1]))
    expect(pointNamedIn('Find z = 2 − j0.5.')).toEqual(z([2, -0.5]))
    expect(pointNamedIn('Click the point z=j1')).toEqual(z([0, 1]))
    expect(pointNamedIn('Click **z = 0.5 − j0.5**')).toEqual(z([0.5, -0.5]))
    expect(pointNamedIn('Where does it sit? (y = 0.4 + j0.2)')).toEqual(y([0.4, 0.2]))
    expect(pointNamedIn('Click $z = 0.5 + j1$')).toEqual(z([0.5, 1]))
  })

  it('review fixes: every value named, decimal commas, ohms skipped, numbers that don\'t belong', () => {
    expect(pointNamedIn('Starting from z = 1 + j1, click where z = 1 − j1 is.')).toEqual(z([1, 1], [1, -1]))
    expect(pointNamedIn('click z = 0,5 + j1')).toEqual(z([0.5, 1]))
    expect(pointNamedIn('Click where z = 50 Ω is')).toBeNull() // in ohms: no value, and no word to go on
    expect(pointNamedIn('Find z = 25 + j50 ohms on the chart')).toBeNull()
    expect(pointNamedIn('z = 0.5 + j1.0 2 times')).toEqual(z([0.5, 1]))
    expect(pointNamedIn('If Δz = 0.1, click z = 1')).toEqual(z([1, 0]))
    expect(pointNamedIn('Here 1/z = 0.5: click the impedance')).toEqual({ via: 'z', values: [] })
  })

  it('re-review fixes: a word starting with j is not the imaginary unit; siemens are skipped', () => {
    expect(pointNamedIn('Click where z = 1 just above the axis')).toEqual(z([1, 0]))
    expect(pointNamedIn('The point z = 2 jumps when you add it')).toEqual(z([2, 0]))
    expect(pointNamedIn('Click y = 20 mS')).toBeNull()
    expect(pointNamedIn('Find y = 0.02 S on the chart')).toBeNull()
  })

  it('falls back to the word, and stays out of it when the card is ambiguous', () => {
    expect(pointNamedIn('Click this impedance on the chart')).toEqual({ via: 'z', values: [] })
    expect(pointNamedIn('Now find that admittance')).toEqual({ via: 'y', values: [] })
    expect(pointNamedIn('Click z = 1 and then y = 2')).toBeNull()
    expect(pointNamedIn('Click Z = 25 Ω')).toBeNull()
    expect(pointNamedIn('Is the impedance or the admittance easier here?')).toBeNull()
    expect(pointNamedIn('Click the centre of the chart')).toBeNull()
  })
})

describe('move facts say which way the point goes on screen (Sonnet: "slides down" when it went up)', () => {
  it('a shunt L from the lower half to the centre goes up, toward the centre', () => {
    // z = 0.5 − j0.5 (y = 1 + j1): a shunt L of b = −1 lands on the centre.
    const f = 2.4e9
    const L = 50 / (2 * Math.PI * f) // susceptance −1/(ωL) = −1/Z0
    const m = describeMove(c(25, -25), { id: 'a', kind: 'shuntL', value: L }, f, 50)
    expect(m.on_screen).toBe('on screen it moves up and to the right, toward the centre overall') // Γ = −0.2 − j0.4 → 0
    expect(m.summary).toContain(m.on_screen)
  })

  it('the admittance circle is described as it looks (dashed), not "red"', () => {
    const m = describeMove(c(25, -25), { id: 'a', kind: 'shuntC', value: 1e-12 }, 2.4e9, 50)
    expect(m.follows).not.toMatch(/red/)
    expect(m.follows).toMatch(/dashed/)
  })

  it('review fix: a long line move goes round, not "barely" (start and end nearly coincide)', () => {
    const full = describeMove(c(100, 50), { id: 'l', kind: 'tline', value: 179, zc: 50 }, 2.4e9, 50)
    expect(full.on_screen).toMatch(/all the way round, clockwise/)
    const most = describeMove(c(100, 50), { id: 'l', kind: 'tline', value: 120, zc: 50 }, 2.4e9, 50)
    expect(most.on_screen).toMatch(/^on screen it goes more than halfway round, clockwise; it moves /)
  })

  it('re-review fix: past a full turn it says so, with the leftover angle', () => {
    expect(screenMove(c(0.3, 0.1), c(0.1, 0.3), { deg: 432, rotation: 'clockwise' })).toBe('on screen it goes all the way round, clockwise, then 72° more')
    expect(screenMove(c(0.3, 0.1), c(0.1, 0.3), { deg: 800, rotation: 'clockwise' })).toMatch(/all the way round 2 times, clockwise, then 80° more/)
  })

  it('small or edge moves are worded plainly', () => {
    expect(screenMove(c(0.1, 0.1), c(0.105, 0.1))).toBe('on screen it moves barely overall')
    expect(screenMove(c(0.5, 0), c(0.2, 0))).toBe('on screen it moves to the left, toward the centre overall')
    expect(screenMove(c(0.5, 0), c(Infinity, 0))).toMatch(/edge/)
  })
})
