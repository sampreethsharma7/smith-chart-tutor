/**
 * Choosing a local (Ollama) tutor model for this machine, and judging how it runs.
 *
 * The candidates and their scores come from the app's own benchmark (the reference
 * results that ship with it), so "best" means best at the tutor's real jobs (guiding,
 * tool use, RF knowledge and maths, learner tracking), not best in general. Only
 * models that passed it with tool calling are offered.
 */
import reference from './benchmark-reference.json'

export interface MachineInfo {
  platform: string
  arch: string
  ramGB: number
  cpu: string
  /** A GPU Ollama can use well: NVIDIA (its own memory) or Apple Silicon (shares the RAM) */
  gpu?: { name: string; kind: 'nvidia' | 'apple'; memoryGB: number }
}

export interface LocalModel {
  model: string
  /** Download size */
  downloadGB: number
  /** Memory it needs to run with the tutor's context, model and cache together */
  needsGB: number
  /** Overall score on the app's benchmark (0–1), from the shipped reference results */
  score: number
}

const scoreOf = (model: string): number => {
  const runs = (Array.isArray(reference) ? reference : []) as Array<{ model?: string; scores?: { overall?: number } }>
  return runs.find((r) => r.model === model)?.scores?.overall ?? 0
}

/** Best first. qwen3:8b led the local models on the tutor benchmark; qwen3:1.7b is the best small one. */
export const LOCAL_MODELS: LocalModel[] = [
  { model: 'qwen3:8b', downloadGB: 5.2, needsGB: 7, score: scoreOf('qwen3:8b') },
  { model: 'qwen3:1.7b', downloadGB: 1.4, needsGB: 3, score: scoreOf('qwen3:1.7b') }
]

/** Ollama's own download for this OS (the Windows and Linux builds include the NVIDIA libraries). */
export function ollamaDownloadGB(platform: string, arch: string): number {
  if (platform === 'darwin') return 0.2
  if (arch === 'arm64') return platform === 'win32' ? 0.2 : 1.5
  return 1.4
}

export interface Recommendation {
  pick: LocalModel | null
  /** Where it will run: fully on the GPU, or on the processor (slower) */
  runsOn: 'gpu' | 'cpu'
  /** Plain-words reason, for the learner */
  reason: string
  /** A smaller fallback if the pick turns out slow */
  smaller?: LocalModel
  /** Something to know before choosing a local model */
  caution?: string
}

const gb = (x: number) => `${Math.round(x)} GB`

/** Apple Silicon shares RAM with the GPU; macOS lets the GPU use about two thirds of it. */
export function gpuMemoryGB(m: MachineInfo): number {
  if (!m.gpu) return 0
  return m.gpu.kind === 'apple' ? m.gpu.memoryGB * 0.66 : m.gpu.memoryGB
}

export function recommendLocal(m: MachineInfo): Recommendation {
  const [big, small] = LOCAL_MODELS
  const vram = gpuMemoryGB(m)
  const where = m.gpu ? (m.gpu.kind === 'apple' ? `your ${m.gpu.name}'s ${gb(vram)} of usable memory` : `your ${m.gpu.name}'s ${gb(vram)}`) : ''
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (vram >= big.needsGB) {
    return {
      pick: big, runsOn: 'gpu', smaller: small,
      reason: `${big.model} fits in ${where} and scored ${pct(big.score)} on the tutor benchmark, the best of the local models tested.`
    }
  }
  if (vram >= small.needsGB) {
    return {
      pick: small, runsOn: 'gpu',
      reason: `${small.model} fits in ${where} (the larger ${big.model} needs about ${gb(big.needsGB)}). It scored ${pct(small.score)} on the tutor benchmark.`
    }
  }
  if (m.ramGB >= 8) {
    return {
      pick: small, runsOn: 'cpu',
      reason: `No GPU that a local model can use was found, so it will run on the processor. ${small.model} is small enough to stay usable there; it scored ${pct(small.score)} on the tutor benchmark.`,
      caution: 'On the processor, answers come slower than from a cloud model. The speed check after setup will tell you how slow.'
    }
  }
  return {
    pick: null, runsOn: 'cpu',
    reason: `This computer has ${gb(m.ramGB)} of memory and no GPU a local model can use: too little to run a local tutor well.`,
    caution: 'Use a cloud model instead (Models → add Anthropic, Google Gemini or OpenAI). Several have free or cheap tiers.'
  }
}

/** What the app found of Ollama on this machine */
export interface OllamaStatus {
  running: boolean
  version: string | null
  /** Models already downloaded */
  models: string[]
  binary: string | null
  /** The binary is the app's own copy */
  managed: boolean
  /** The endpoint for the app's Ollama connection */
  apiBase: string
}

export interface SetupProgress {
  step: 'install' | 'start' | 'model' | 'speed'
  text: string
  /** 0–1 when known */
  fraction?: number
}

export type SetupResult = { ok: true; speed: SpeedResult; apiBase: string } | { ok: false; error: string }

export interface SpeedResult {
  /** Seconds until the answer starts appearing (after the model is loaded) */
  firstTokenS: number
  tokensPerSec: number
  /** Share of the model in GPU memory, 0–1 (1 = fully on the GPU) */
  gpuShare: number
  /** Seconds to load the model into memory (once per session) */
  loadS: number
}

export interface SpeedVerdict {
  verdict: 'good' | 'ok' | 'slow'
  text: string
}

export function judgeSpeed(r: SpeedResult): SpeedVerdict {
  const words = Math.max(1, Math.round(r.tokensPerSec * 0.75))
  const start = r.firstTokenS < 1.5 ? 'start almost at once' : `start after about ${Math.round(r.firstTokenS)} s`
  const place = r.gpuShare >= 0.95 ? 'fully on your GPU' : r.gpuShare > 0.05 ? `${Math.round(r.gpuShare * 100)}% on your GPU, the rest on the processor` : 'on the processor'
  const facts = `Answers ${start} and come at about ${words} words a second (${place}).`
  if (r.tokensPerSec >= 15 && r.firstTokenS <= 12) return { verdict: 'good', text: `${facts} That's comfortable for tutoring.` }
  if (r.tokensPerSec >= 6 && r.firstTokenS <= 30) return { verdict: 'ok', text: `${facts} Usable, with some waiting.` }
  return { verdict: 'slow', text: `${facts} That's slow for a conversation.` }
}
