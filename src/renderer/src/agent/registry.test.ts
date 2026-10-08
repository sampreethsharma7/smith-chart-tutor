import { describe, expect, it } from 'vitest'
import { coerce } from './registry'

describe('tool argument coercion', () => {
  it('fixes stringly-typed arguments from weak models', () => {
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'number' }, b: { type: 'boolean' },
        arr: { type: 'array', items: { type: 'number' } },
        o: { type: 'object', properties: { r: { type: 'number' } } }
      }
    }
    expect(coerce(schema, { n: '1.5', b: 'true', arr: ['1', 2], o: '{"r":"50"}', extra: 'x' }))
      .toEqual({ n: 1.5, b: true, arr: [1, 2], o: { r: 50 }, extra: 'x' })
  })
})
