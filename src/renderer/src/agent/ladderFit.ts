import { checkRung, RUNG_REASONS } from '@shared/ladder'
import type { GradedMeta } from '@shared/memory'
import { checkValues } from '@shared/reading'
import type { ToolContext } from './types'

/** The parameter every graded tool takes, to go easier than the learner's rung on purpose. */
export const RUNG_REASON = {
  rung_reason: {
    type: 'string',
    enum: RUNG_REASONS,
    description: 'Only to go easier than the app allows: an item 2+ rungs below their level on the independence ladder (the app refuses those otherwise): "warm_up" (once a lesson), "after_miss" (right after they missed one on this skill), "learner_asked" (they asked for an easier one). Also for showing the values on a reading question when they read from the chart'
  }
}

/**
 * Hold a graded item to the learner's rung (ladder.ts). Call it before the card is shown: a refusal
 * throws, so nothing changes on screen. Returns the note for the tutor, and counts an allowed reason
 * against the lesson's allowance.
 */
export function fitRung(ctx: ToolContext, graded: GradedMeta, reason: unknown): string {
  const p = ctx.profile?.()
  if (!p) return ''
  const fit = checkRung(p, graded, { reason: typeof reason === 'string' ? reason : undefined, used: ctx.session?.()?.rungOverrides })
  if (!fit.ok) throw new Error(fit.message)
  if (fit.override && ctx.session?.()) {
    const at = new Date().toISOString()
    ctx.updateSession?.((s) => ({ ...s, rungOverrides: [...(s.rungOverrides ?? []), { reason: fit.override!, skill: graded.skill, at }] }))
  }
  return fit.message
}

/** The parameter reading questions take: cover the on-screen values or show them (reading.ts). */
export const VALUES = {
  values: {
    type: 'string',
    enum: ['covered', 'shown'],
    description: 'Usually leave out: the app covers the readout, hover values and tables while the question is open once they read this skill from the chart, and shows them while they are still learning where the numbers are. "covered" for a beginner: a stretch. "shown" once they read from the chart: needs rung_reason.'
  }
}

/**
 * Whether a reading question covers the values (reading.ts). Call it before the card is shown: a
 * refusal throws. Without a learner (no profile) the values are covered: the safe default.
 */
export function fitValues(ctx: ToolContext, graded: GradedMeta, want: unknown, reason: unknown): { values: 'covered' | 'shown'; note: string } {
  const p = ctx.profile?.()
  const w = want === 'covered' || want === 'shown' ? want : undefined
  if (!p) return { values: w ?? 'covered', note: '' }
  const fit = checkValues(p, graded.skill, w, { reason: typeof reason === 'string' ? reason : undefined, used: ctx.session?.()?.rungOverrides })
  if (!fit.ok) throw new Error(fit.message)
  if (fit.override && ctx.session?.()) {
    const at = new Date().toISOString()
    ctx.updateSession?.((s) => ({ ...s, rungOverrides: [...(s.rungOverrides ?? []), { reason: fit.override!, skill: graded.skill, at }] }))
  }
  return { values: fit.values, note: fit.message }
}
