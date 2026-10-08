import type { JsonSchema } from '@shared/llm'
import type { Profile, SessionRecord } from '@shared/profile'
import type { Derived } from '@/state/derived'
import type { useStudio } from '@/state/studio'

export interface ToolContext {
  studio: ReturnType<typeof useStudio.getState>
  derived(): Derived
  profile(): Profile
  updateProfile(fn: (p: Profile) => Profile): Promise<void>
  /** Number of learner inputs this session (typed messages, predictions, exercise checks) */
  learnerTurns(): number
  /** Record an exercise result in the current session log */
  recordExercise(e: { title: string; skill?: string; passed: boolean; attempts: number }): void
  /** The lesson in progress */
  session(): SessionRecord | null
  updateSession(fn: (s: SessionRecord) => SessionRecord): void
  /** The goal is reached: the lesson is saved and wrapped up once the tutor has replied */
  completeLesson(): void
  /** The learner just solved a task and the tutor still owes them a follow-up question */
  followUpPending?(): boolean
  /** The app already recorded this skill from the graded answer the tutor is responding to */
  autoRecorded?(skill: string): boolean
}

/**
 * A tutor tool. To add a new capability, drop a file in `agent/tools/` that
 * default-exports an array of these — it is picked up automatically and
 * offered to the model; the model decides when to use it.
 */
export interface AgentTool<A = any> {
  name: string
  description: string
  parameters: JsonSchema
  /** Short text for the activity line in the chat, e.g. "Drawing on the chart" */
  activity?(args: A): string
  /** The learner must act next (exercise/prediction): the tutor gets one more reply, then stops */
  endsTurn?: boolean
  run(args: A, ctx: ToolContext): unknown | Promise<unknown>
}

export const defineTools = (tools: AgentTool[]) => tools
