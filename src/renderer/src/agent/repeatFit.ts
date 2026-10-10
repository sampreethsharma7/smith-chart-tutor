import { itemSignature } from '@shared/course'
import { repeatError, repeatOf, reusedError, reusedValues } from '@shared/repeats'
import type { PartValue } from '@shared/rf/giveaway'
import type { Prediction } from '@/state/studio'
import type { ToolContext } from './types'

/** Refused (thrown for the tutor) when they just answered this exact item right (repeats.ts). */
export function checkRepeat(ctx: ToolContext, sig: string): void {
  const p = ctx.profile?.()
  if (!p) return
  const r = repeatOf(p, sig, new Date().toISOString(), ctx.session?.()?.id)
  if (r) throw new Error(repeatError(r))
}

/** Refused when every solution of a new task reuses the part values of their last tasks (repeats.ts). */
export function checkReuse(ctx: ToolContext, solutions: Array<Array<Omit<PartValue, 'text'>>>): void {
  const p = ctx.profile?.()
  if (!p) return
  const reused = reusedValues(p, solutions, ctx.session?.()?.id)
  if (reused) throw new Error(reusedError(reused))
}

/** Show a question card: a graded one is signed (what is asked, not its wording) and refused if it's a repeat. */
export function showCard(ctx: ToolContext, card: Prediction): void {
  if (card.key && card.graded) {
    const sig = itemSignature(card.key)
    checkRepeat(ctx, sig)
    card = { ...card, graded: { ...card.graded, sig } }
  }
  ctx.studio.setPrediction(card)
}
