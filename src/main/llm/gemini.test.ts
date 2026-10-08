import { describe, expect, it } from 'vitest'
import { hasParams, sanitize } from './gemini'

describe('Gemini schema sanitizer', () => {
  it('keeps string enums, drops numeric enums, strips unsupported keys', () => {
    const s = sanitize({
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', enum: ['correct', 'incorrect'] },
        difficulty: { type: 'number', enum: [1, 2, 3] },
        tags: { type: 'array', items: { type: ['string', 'null'] } }
      }
    })
    expect(s.additionalProperties).toBeUndefined()
    expect(s.properties!.outcome.enum).toEqual(['correct', 'incorrect'])
    expect(s.properties!.difficulty.enum).toBeUndefined()
    expect(s.properties!.tags.items!.type).toBe('string')
  })
  it('detects tools without arguments', () => {
    expect(hasParams({ type: 'object', properties: {} })).toBe(false)
    expect(hasParams({ type: 'object', properties: { x: { type: 'number' } } })).toBe(true)
  })
})
