import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useStudio } from './state/studio'
import { useTutor } from './agent/tutor'
import { useDesigner } from './agent/designer'
import { useApp } from './state/app'
import { useCalc } from './state/calc'
import { findReach } from '@shared/rf/tasks'
import { solveLMatch, toNetwork } from '@shared/rf/solvers'
import { inputImpedance, loadImpedance } from '@shared/rf/network'
import { runTool } from './agent/registry'
import { computeDerived } from './state/derived'
import './styles.css'

// Test harness only (the app was started with SMITH_CAPTURE): a script can act as the learner.
if ((window as unknown as { smithDevHooks?: boolean }).smithDevHooks) {
  // A tool context like the tutor's, so a script can open real cards.
  const toolCtx = {
    get studio() { return useStudio.getState() },
    derived: () => computeDerived(useStudio.getState().snapshot()),
    profile: () => useApp.getState().profile,
    updateProfile: (fn: never) => useApp.getState().updateProfile(fn),
    learnerTurns: () => 1,
    session: () => useTutor.getState().session
  }
  Object.assign(window, { __smith: { useStudio, useTutor, useDesigner, useApp, useCalc, findReach, solveLMatch, toNetwork, loadImpedance, inputImpedance, tool: (name: string, args: Record<string, unknown>) => runTool(name, args, toolCtx as never) } })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
