import { describe, expect, it } from 'vitest'
import { sureAt } from './SureButton'

describe('one click says the answer and how sure', () => {
  it('left third guessing, middle not sure, right third sure; the edges stay inside', () => {
    expect([0, 0.2, 0.34, 0.5, 0.66, 0.67, 0.9, 1].map(sureAt)).toEqual(['guess', 'guess', 'unsure', 'unsure', 'unsure', 'sure', 'sure', 'sure'])
    expect(sureAt(-0.1)).toBe('guess')
    expect(sureAt(1.2)).toBe('sure')
  })
})
