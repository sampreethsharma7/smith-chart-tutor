/** Iterate Server-Sent-Event `data:` payloads from a fetch Response. */
export async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
        const data = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) yield data
      }
    }
    const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

export async function httpError(res: Response, provider: string): Promise<Error> {
  let detail = ''
  try {
    const body = await res.text()
    try {
      const j = JSON.parse(body)
      detail = j.error?.message ?? j.message ?? body
    } catch {
      detail = body
    }
  } catch {
    /* ignore */
  }
  return new Error(`${provider} HTTP ${res.status}: ${detail.slice(0, 500)}`)
}

export function safeJson(s: string): Record<string, unknown> {
  if (!s.trim()) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : { value: v }
  } catch {
    return { _unparsed: s }
  }
}
