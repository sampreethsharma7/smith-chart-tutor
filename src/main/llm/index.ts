import type { ChatRequest, ProviderConfig, StreamEvent } from '@shared/llm'
import { anthropicChat, anthropicModels } from './anthropic'
import { openaiChat, openaiModels } from './openai'
import { geminiChat, geminiModels } from './gemini'

export type Emit = (ev: StreamEvent) => void

const active = new Map<string, AbortController>()

/**
 * Overload and rate-limit errors are usually temporary, so retry them with
 * backoff, but only before anything has been streamed (never duplicate output).
 * Daily quotas, retired models and bad keys are not retried.
 */
export function retryDelayMs(message: string, attempt: number, local: boolean): number | null {
  if (attempt >= 3) return null
  // The provider says when to come back; only wait if that's soon.
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message)
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
    return ms <= 60000 ? Math.max(1000, ms) : null
  }
  if (/billing.*(not|disabled)|no longer available|not found|per_?day|PerDay|invalid.*key|HTTP 40[0134]\b/i.test(message) && !/HTTP 429/.test(message)) return null
  if (/HTTP 429|rate.?limit|quota/i.test(message)) return /per_?day|PerDay/i.test(message) ? null : [15000, 30000, 45000][attempt]
  if (/HTTP (408|409|425|5\d\d)|overloaded|high demand|temporarily|ECONNRESET|socket hang up/i.test(message)) return [2000, 6000, 15000][attempt]
  if (/fetch failed|ETIMEDOUT/i.test(message) && !local) return [2000, 6000, 15000][attempt]
  return null
}

/**
 * How long a model may send nothing before the request counts as stalled. Cloud models that think
 * before answering can be quiet for a while; a local model reading a long prompt on a CPU, longer.
 */
export const stallLimitMs = (local: boolean) => (local ? 300_000 : 90_000)

export async function runChat(
  cfg: ProviderConfig, key: string, req: ChatRequest, requestId: string, emit: Emit,
  opts: { stallMs?: number } = {}
) {
  const ctrl = new AbortController()
  active.set(requestId, ctrl)
  let streamed = false
  const local = /localhost|127\.0\.0\.1/.test(cfg.baseUrl ?? '')
  const stallMs = opts.stallMs ?? stallLimitMs(local)
  let stalled = false
  let stallRetried = false
  try {
    for (let attempt = 0; ; attempt++) {
      // A stall watchdog per attempt: restarted by everything the model sends, it cancels a silent request.
      const watch = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => { stalled = true; watch.abort() }, stallMs)
      }
      const tracked: Emit = (ev) => {
        if (ev.type === 'text' || ev.type === 'tool_call') streamed = true
        arm()
        emit(ev)
      }
      stalled = false
      arm()
      const signal = AbortSignal.any([ctrl.signal, watch.signal])
      try {
        if (cfg.kind === 'anthropic') await anthropicChat(cfg, key, req, tracked, signal)
        else if (cfg.kind === 'gemini') await geminiChat(cfg, key, req, tracked, signal)
        else await openaiChat(cfg, key, req, tracked, signal)
        if (stalled) throw new Error('stalled') // a provider that returns quietly on abort
        return
      } catch (e) {
        if (ctrl.signal.aborted) throw e
        if (stalled) {
          // Silent from the start: ask once more. Part of a reply already shown: never send it twice.
          if (streamed || stallRetried) throw new Error(stallMessage(cfg, stallMs))
          stallRetried = true
          continue
        }
        const msg = e instanceof Error ? e.message : String(e)
        const wait = streamed ? null : retryDelayMs(msg, attempt, local)
        if (wait === null) throw e
        await new Promise((r) => setTimeout(r, wait))
        if (ctrl.signal.aborted) throw e
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (e) {
    const msg = ctrl.signal.aborted ? 'Cancelled' : e instanceof Error ? friendly(e, cfg) : String(e)
    emit({ type: 'error', message: msg })
  } finally {
    active.delete(requestId)
  }
}

function stallMessage(cfg: ProviderConfig, ms: number): string {
  return `${cfg.label || cfg.model} stopped responding (nothing for ${Math.round(ms / 1000)} s). Nothing was lost: send your message again, or pick another model at the top.`
}

export function abortChat(requestId: string) {
  active.get(requestId)?.abort()
}

export async function listModels(cfg: ProviderConfig, key: string): Promise<string[]> {
  if (cfg.kind === 'anthropic') return anthropicModels(cfg, key)
  if (cfg.kind === 'gemini') return geminiModels(cfg, key)
  return openaiModels(cfg, key)
}

function friendly(e: Error, cfg: ProviderConfig): string {
  const m = e.message
  if (/fetch failed|ECONNREFUSED/i.test(m) && cfg.baseUrl?.includes('localhost')) {
    return `Could not reach ${cfg.baseUrl}. Is the local server (Ollama / LM Studio) running?`
  }
  if (/HTTP 401|HTTP 403/.test(m)) return `${m}\n→ Check the API key for this connection in Models.`
  if (/no longer available|not found/i.test(m) && /HTTP 404/.test(m)) return `${m}\n→ This model was retired or renamed. Pick another in Models → Choose models.`
  if (/HTTP 429/.test(m) && /free_tier/i.test(m)) {
    const limit = /limit: (\d+)/.exec(m)?.[1]
    const when = /retry in ([\dhms.]+)/i.exec(m)?.[1]?.replace(/\.\d+s$/, 's')
    return `Free-tier limit reached for this model${limit ? ` (${limit} requests)` : ''}${when ? `; it resets in ${when}` : ''}.\n→ Enable billing for this key with the provider, or pick another model.`
  }
  if (/HTTP 429/.test(m)) return `${m}\n→ Rate limit or quota reached for this key. Wait a bit, or check your plan with the provider.`
  return m
}
