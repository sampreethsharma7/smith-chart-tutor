import { describe, expect, it } from 'vitest'
import { retryDelayMs } from './index'

describe('API retry policy', () => {
  it('retries overload and per-minute rate limits, not permanent errors', () => {
    expect(retryDelayMs('Gemini HTTP 503: This model is currently experiencing high demand.', 0, false)).toBe(2000)
    expect(retryDelayMs('Anthropic HTTP 529: Overloaded', 2, false)).toBe(15000)
    expect(retryDelayMs('Gemini HTTP 429: Quota exceeded for metric: generate_requests_per_minute', 0, false)).toBe(15000)
    expect(retryDelayMs('Gemini HTTP 429: Quota exceeded for metric: requests_per_day', 0, false)).toBeNull()
    expect(retryDelayMs('Gemini HTTP 404: This model models/gemini-2.5-pro is no longer available', 0, false)).toBeNull()
    expect(retryDelayMs('Anthropic HTTP 401: invalid x-api-key', 0, false)).toBeNull()
    expect(retryDelayMs('fetch failed', 0, true)).toBeNull() // local server down: don't wait
    expect(retryDelayMs('Gemini HTTP 503: high demand', 3, false)).toBeNull() // give up after 3 retries
    // Provider-specified waits: honour short ones, fail fast on long ones.
    expect(retryDelayMs('HTTP 429: free_tier_requests, limit: 20. Please retry in 3h46.55s.', 0, false)).toBeNull()
    expect(retryDelayMs('HTTP 429: per minute. Please retry in 12.5s.', 0, false)).toBe(12500)
  })
})
