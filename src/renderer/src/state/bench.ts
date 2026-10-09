import { create } from 'zustand'
import { runBenchmark, type BenchCheck } from '@shared/benchmark'
import { callLLM } from '@/agent/tutor'
import { switchLock, useApp } from './app'

interface Progress {
  text: string
  checks: BenchCheck[]
}

/** Benchmark runs live here (not in a component) so they keep going and stay visible across tab switches. */
export const useBench = create<{ running: Record<string, Progress>; run(providerId: string): Promise<void> }>((set, get) => ({
  running: {},
  async run(providerId) {
    if (get().running[providerId]) return
    // A course run measures its cost from every request the app makes: not alongside it.
    if (switchLock.on) return
    const p = useApp.getState().settings.providers.find((x) => x.id === providerId)
    if (!p) return
    const setProgress = (pr: Progress | null) => {
      const running = { ...get().running }
      if (pr) running[providerId] = pr
      else delete running[providerId]
      set({ running })
    }
    setProgress({ text: 'Starting…', checks: [] })
    try {
      const r = await runBenchmark(
        (req) => callLLM({ ...req, providerId }),
        { providerId, providerLabel: p.label, model: p.model, kind: p.kind, machine: /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '') ? 'this PC' : undefined },
        (text, checks) => setProgress({ text, checks })
      )
      await useApp.getState().saveBenchmark(r)
      // Flag models whose tool calling doesn't work so the tutor runs chat-only; re-enable if it now works.
      const providers = useApp.getState().settings.providers.map((x) => {
        if (x.id !== providerId || r.tier === 'Failed') return x
        if ((r.scores.tools ?? 0) < 0.3) return { ...x, supportsTools: false }
        if ((r.scores.tools ?? 0) >= 0.6 && x.supportsTools === false) return { ...x, supportsTools: undefined }
        return x
      })
      await useApp.getState().saveProviders(providers)
    } finally {
      setProgress(null)
    }
  }
}))
