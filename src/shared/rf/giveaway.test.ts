import { describe, expect, it } from 'vitest'
import { giveaways, partValuesIn, partValuesOf } from './giveaway'

const REFS = [{ value: 2.28e-9, unit: 'H' as const }, { value: 1.09e-12, unit: 'F' as const }, { value: 72, unit: 'deg' as const }]

describe('part values of the final task are the learner\'s to find', () => {
  it('reads part values as they are written', () => {
    expect(partValuesIn('a series inductor of 2.28 nH, then 1,09 pF and a 4.7nH; a 45° line, 30 degrees')).toEqual([
      { value: 2.28e-9, unit: 'H', text: '2.28 nH' }, { value: 1.09e-12, unit: 'F', text: '1.09 pF' }, { value: expect.closeTo(4.7e-9, 15), unit: 'H', text: '4.7nH' },
      { value: 45, unit: 'deg', text: '45°' }, { value: 30, unit: 'deg', text: '30 degrees' }
    ])
    expect(partValuesIn('VSWR 1.5 at 2.4 GHz, 50 Ω')).toEqual([])
  })

  it('a value within 10% of a reference part gives it away (the re-run: "a series inductor of 2.28 nH is added")', () => {
    expect(giveaways('Starting at your antenna, a series inductor of 2.28 nH is added.', REFS)).toEqual(['2.28 nH'])
    expect(giveaways('1. A series L of 2.3 nH. 2. A shunt C of 1 pF.', REFS)).toEqual(['2.3 nH', '1 pF'])
    expect(giveaways('Try a stub of about 70°.', REFS)).toEqual(['70°'])
    // Far from any reference, or no final task open: nothing.
    expect(giveaways('Your 5 nH went too far.', REFS)).toEqual([])
    expect(giveaways('a series inductor of 2.28 nH', [])).toEqual([])
  })

  it('their own value on the chart is theirs to talk about', () => {
    const own = partValuesOf([{ id: 'a', kind: 'seriesL', value: 2.28e-9 }, { id: 'b', kind: 'shortStub', value: 40 }])
    expect(own).toEqual([{ value: 2.28e-9, unit: 'H' }, { value: 40, unit: 'deg' }])
    expect(giveaways('Your 2.28 nH put you on g = 1; now the shunt C of 1.09 pF.', REFS, own)).toEqual(['1.09 pF'])
  })
})
