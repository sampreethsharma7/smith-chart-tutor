import { auditTurn, type Issue, type IssueKind, type TurnRecord } from '@shared/issues'
import { api } from '@/state/app'

let watcher: ((found: Issue[]) => void) | null = null
/** While set, each turn's faults go here and not to the issue log (a course run). */
export const watchIssues = (w: ((found: Issue[]) => void) | null) => { watcher = w }

/**
 * Notes what one assistant turn said and did, and at the end logs any fault it shows (a drawing
 * claimed but not made, a failed tool, a guard that had to step in…) to the local issue log.
 */
export class TurnAudit {
  private rec: TurnRecord = { texts: [], tools: [], events: [] }

  constructor(private agent: Issue['agent'], private model: string | undefined, private toolNames: string[]) {}

  said(text: string) {
    if (text.trim()) this.rec.texts.push(text)
  }

  tool(name: string, ok: boolean, content: string) {
    this.rec.tools.push({ name, ok, content: content.slice(0, 400) })
  }

  event(kind: IssueKind, detail: string) {
    this.rec.events!.push({ kind, detail })
  }

  finish(): Issue[] {
    const at = new Date().toISOString()
    const found = auditTurn(this.rec, this.toolNames).map((x) => ({ ...x, at, agent: this.agent, ...(this.model ? { model: this.model } : {}) }))
    // A course run counts them in its report instead: they'd bury real lessons' faults in the log.
    if (watcher) {
      watcher(found)
      return found
    }
    if (found.length) {
      try {
        api().issues?.append(found)?.catch(() => {})
      } catch { /* the log is best effort */ }
    }
    return found
  }
}
