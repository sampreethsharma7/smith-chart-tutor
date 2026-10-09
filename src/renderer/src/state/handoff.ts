import { loadImpedance } from '@shared/rf/network'
import { evaluateDesign } from '@shared/rf/design'
import { fmtC, fmtHz } from '@/lib/format'
import { useTutor } from '@/agent/tutor'
import { useDesigner } from '@/agent/designer'
import { partsText } from '@/agent/design/tools'
import { describeLoad, useStudio, type StudioSnapshot } from './studio'
import { useApp } from './app'
import { modelReady } from './journey'
import { confirmDialog } from '@/components/Confirm'

/** The design on the chart, in a sentence for the tutor. */
export function designSummary(s: StudioSnapshot): string {
  const ZL = loadImpedance(s.load, s.designFreq, s.datasets)
  const r = evaluateDesign(s.load, s.datasets, s.network, { z0: s.z0, f0: s.designFreq })
  return `load ${describeLoad(s.load, s.datasets)} (${fmtC(ZL, 'Ω')} at ${fmtHz(s.designFreq)}), Z0 ${s.z0} Ω; ` +
    (s.network.length ? `network (load → source) ${partsText(s.network)}, VSWR ${r.vswr.toFixed(2)} at ${fmtHz(s.designFreq)}` : 'no network yet')
}

/**
 * "Teach me why": take the design from the Design tab into a tutor lesson. The lesson's chart
 * becomes a copy of the design (the Design tab keeps its own), and the tutor teaches from it.
 */
export async function teachMeWhy() {
  const app = useApp.getState()
  if (useTutor.getState().busy || useDesigner.getState().busy) return
  if (!modelReady()) {
    await app.setView('models')
    return
  }
  const snap = useStudio.getState().snapshot()
  const inLesson = useTutor.getState().history.length > 0
  if (inLesson && !(await confirmDialog('A lesson is in progress. Bring this design into it?\n\nThe lesson\'s chart is replaced by a copy of your design; the Design tab keeps its own.', { ok: 'Bring it in' }))) return
  await app.setView('studio')
  if (useApp.getState().view !== 'studio') return
  useStudio.getState().loadSnapshot({ ...snap, annotations: [], exercise: null, prediction: null, overlays: { ...snap.overlays, showLoadTrace: true, showInputTrace: true, showPath: true } })
  const design = designSummary(snap)
  if (inLesson) {
    await useTutor.getState().send(`I brought my design from the Design tab; it's on the chart now: ${design}. Help me understand why it works.`, { display: 'I brought my design from the Design tab. Help me understand why it works.' })
  } else await useTutor.getState().startSession('own', design)
}
