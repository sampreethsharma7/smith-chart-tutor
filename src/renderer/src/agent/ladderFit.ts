import { checkRung, RUNG_REASONS } from '@shared/ladder'
import type { GradedMeta } from '@shared/memory'
import type { ToolContext } from './types'

/** The parameter every graded tool takes, to go easier than the learner's rung on purpose. */
export const RUNG_REASON = {
  rung_reason: {
    type: 'string',
    enum: RUNG_REASONS,
    description: 'Only for an item 2+ rungs below their level on the independence ladder (the app refuses those otherwise): "warm_up" (once a lesson), "after_miss" (right after they missed one on this skill), "learner_asked" (they asked for an easier one)'
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
