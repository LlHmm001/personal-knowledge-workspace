import { describe, expect, it } from 'vitest'
import { quadrantOf } from '../src/index.ts'

describe('quadrantOf', () => {
  it('derives Q1–Q4 from important × urgent', () => {
    expect(quadrantOf({ important: true, urgent: true })).toBe(1)
    expect(quadrantOf({ important: true, urgent: false })).toBe(2)
    expect(quadrantOf({ important: false, urgent: true })).toBe(3)
    expect(quadrantOf({ important: false, urgent: false })).toBe(4)
  })
})
