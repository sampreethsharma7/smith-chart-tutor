import { ELEMENT_LABEL } from '@shared/rf/network'
import { gradeQuestion, type QuestionKey } from '@shared/rf/tasks'
import { elementValueText, useStudio } from '@/state/studio'
import { FOLLOW_UP, gradeExercise, solutionFacts, type ExerciseGrade } from '@/state/exercise'
import { recordGraded, type AnswerFormat, type GradedMeta, type GradedResult } from '@shared/memory'
import { partValuesOf } from '@shared/rf/giveaway'
import { addSlips, patternNews, slipsFor, type SlipFinding } from '@shared/patterns'
import type { Outcome, SkillId, Sure } from '@shared/profile'
import type { ValuesSeen } from '@shared/reading'
import { useApp } from '@/state/app'
import { completeProject, projectPassNote } from '@shared/capstone'
import { useTutor } from './tutor'

/**
 * Record a graded result in the learner's memory (skill estimate, topic level,
 * review date, misconceptions). Returns the report for the tutor, or '' if nothing
 * was recorded (no profile, or an ungraded card).
 */
async function remember(
  meta: GradedMeta | undefined, outcome: Outcome, label: string,
  how: { misconception?: string; format?: AnswerFormat; choices?: number; helped?: boolean; sure?: Sure; slips?: SlipFinding[]; values?: ValuesSeen; parts?: GradedResult['parts'] } = {}
): Promise<string> {
  const app = useApp.getState()
  if (!meta || !app.profile) return ''
  let report = ''
  await app.updateProfile((p) => {
    const at = new Date().toISOString()
    const session = useTutor.getState().session?.id ?? 'none'
    const { slips, ...rest } = how
    const r = recordGraded(p, { meta, outcome, label, session, at, ...rest })
    // What kind of wrong it was (exact, from the answer): kept so the same confusion can be seen
    // across topics and lessons. A wrong guess shows a gap, not a confusion.
    const found = how.sure === 'guess' ? [] : slips ?? []
    const next = addSlips(r.profile, found, { at, session, topic: meta.topic, ctx: meta.ctx })
    const news = patternNews(r.profile, next)
    report = [r.report, ...found.map((f) => `slip: ${f.detail} (${f.confusion})`), ...news].join(' ')
    return next
  })
  return report
}

/**
 * What happens when the learner answers a card or presses Check. Grading is
 * done here, by the app; the tutor is told the result and responds to it.
 */

/** Press "Check" on the task card. A first pass hands the tutor their solution and a follow-up to ask. */
export function checkExercise(): ExerciseGrade | null {
  void checkExerciseAsync()
  const ex = useStudio.getState().exercise
  return ex ? lastGrade : null
}

let lastGrade: ExerciseGrade | null = null

/** The same, awaitable (tests, and anything that needs the tutor's reply to have arrived). */
export async function checkExerciseAsync(): Promise<ExerciseGrade | null> {
  const st = useStudio.getState()
  const ex = st.exercise
  // The tutor must hear the result: not while it's writing, and not twice at once.
  if (!ex || checking || useTutor.getState().busy) return null
  checking = true
  try {
    return await checkOnce(ex)
  } finally {
    checking = false
  }
}

let checking = false

async function checkOnce(ex: NonNullable<ReturnType<typeof useStudio.getState>['exercise']>): Promise<ExerciseGrade | null> {
  const st = useStudio.getState()
  const g = gradeExercise(ex)
  lastGrade = g
  const firstPass = g.passed && ex.status !== 'passed'
  const next = { ...ex, attempts: ex.attempts + 1, status: g.passed ? ('passed' as const) : ex.status }
  st.setExercise(next)
  if (g.passed) useTutor.getState().logExercise(next, true)
  const net = st.network.map((e) => `${ELEMENT_LABEL[e.kind]} ${elementValueText(e)}`).join(' → ') || 'no elements'
  const what = ex.kind === 'reach' ? 'Task' : 'Exercise'
  const solved = firstPass ? `\n[Their solution, each move verified]\n${solutionFacts(ex)}\n[Follow-up] ${FOLLOW_UP}` : ''
  // Only a first pass is evidence (checks before it are work in progress). Right first time and on their
  // own is fully theirs; after several checks or talking it through with the tutor, partly.
  const report = firstPass ? await remember(ex.graded, 'correct', ex.title, { format: 'task', helped: !!ex.helped || next.attempts > 1, parts: partValuesOf(st.network) }) : ''
  const miss = g.tutorNote ? `\n[Which way they missed, from the app] ${g.tutorNote}` : ''
  // The final task of their project, passed: the project is done (capstone.ts).
  let project = ''
  if (firstPass && ex.capstone) {
    const forProject = ex.capstone.at
    const session = useTutor.getState().session?.id
    let marked = false
    await useApp.getState().updateProfile((p) => {
      const r = completeProject(p, forProject, new Date().toISOString(), session)
      marked = r.marked
      return r.profile
    })
    project = `\n${projectPassNote(marked)}`
  }
  await useTutor.getState().send(`[${what} check #${next.attempts}] ${g.summary}. Network (load → source): ${net}.${miss}${project}${solved}${report ? `\n[Learner memory] ${report}` : ''}`, {
    learnerAction: true,
    display: `✔ Checked (#${next.attempts}): ${g.summary}`,
    followUp: firstPass,
    autoRecorded: report && ex.graded ? [ex.graded.skill] : []
  })
  return g
}

/**
 * Answer the open question card. A graded question is checked first; an answer the
 * app can't read (no number, no click) returns a message and leaves the card open.
 */
export function answerQuestion(answer: string, sure?: Sure, reason?: string): string | null {
  const r = gradeOpenQuestion(answer, sure, reason)
  if (r.problem !== null || !r.finish) return r.problem
  void r.finish()
  return null
}

/** How sure they were, as the tutor reads it. */
export const SURE_TEXT: Record<Sure, string> = { sure: 'sure', unsure: 'not sure', guess: 'guessing' }

/**
 * Grade the open card; `finish` records it and tells the tutor (awaitable). `sure`: how sure
 * they said they were; `reason`: the "why" they picked on a two-part question.
 */
export function gradeOpenQuestion(answer: string, sure?: Sure, reason?: string): { problem: string | null; finish?: () => Promise<void> } {
  const st = useStudio.getState()
  const p = st.prediction
  if (!p) return { problem: null }
  if (useTutor.getState().busy) return { problem: 'One moment: the tutor is still writing. Answer when it has finished.' }
  const tag = p.followUp ? ' (follow-up on their solution)' : ''
  if (!p.key) {
    st.setPrediction(null)
    return { problem: null, finish: () => useTutor.getState().send(`[Prediction] Q: ${p.question}\nMy answer: ${answer}`, { learnerAction: true, display: `My prediction: ${answer}` }) }
  }
  const key = p.key
  const g = gradeQuestion(key, { choice: answer, reason, text: answer, gamma: p.answeredGamma })
  if (g.status === 'unreadable') return { problem: g.shown }
  st.setPrediction(null)
  const right = g.status === 'correct'
  const outcome: Outcome = right ? 'correct' : g.status === 'partial' ? 'partial' : 'incorrect'
  const wrongIdea = ideaShown(key, answer, reason, g.status)
  const slips = right ? [] : slipsFor(key, { choice: answer, reason, text: answer, gamma: p.answeredGamma })
  const said = reason ? `${answer}, because: ${reason}` : answer
  return {
    problem: null,
    finish: async () => {
      useTutor.getState().logExercise({ id: p.id, kind: key.type, title: p.title ?? p.question, skill: p.skill, attempts: 1 }, right)
      const format: AnswerFormat = key.type === 'move' || key.type === 'pick' ? 'mcq' : key.type === 'locate' ? 'click' : 'value' // component: a typed value
      // Guessing a two-part answer means guessing both parts.
      const choices = key.type === 'move' ? key.choices.length * (key.reasons?.choices.length ?? 1) : key.type === 'pick' ? key.choices.length : undefined
      const values: ValuesSeen | undefined = !p.values ? undefined : p.typed ? 'typed' : p.values === 'covered' && p.revealed ? 'revealed' : p.values
      const report = await remember(p.graded, outcome, p.title ?? p.question, { misconception: wrongIdea, format, choices, helped: p.helped, sure, slips, values })
      const how = (sure ? ` (they said: ${SURE_TEXT[sure]})` : '') + (values === 'revealed' ? ' (they uncovered the values before answering)' : '')
      await useTutor.getState().send(`[Question answered${tag}] Q: ${p.question}\nMy answer: ${said}${how}\nApp grading: ${g.detail}${report ? `\n[Learner memory] ${report}` : ''}`, {
        learnerAction: true,
        display: `My answer: ${said}${sure ? ` · ${SURE_TEXT[sure]}` : ''} — ${right ? '✓ correct' : g.status === 'partial' ? '◐ right answer, not the reason' : '✗ not quite'}`,
        autoRecorded: report && p.graded ? [p.graded.skill as SkillId] : []
      })
    }
  }
}

/** The wrong idea an answer shows, if it shows one: a wrong direction, a wrong reason, a missed mistake. */
function ideaShown(key: QuestionKey, answer: string, reason: string | undefined, status: string): string | undefined {
  if (status === 'correct') return undefined
  if (key.type === 'move') {
    if (status === 'wrong') return wrongMoveIdea(key.facts, answer, key.choices[key.correct])
    const j = key.reasons?.choices.indexOf(reason ?? '') ?? -1
    return j >= 0 ? key.reasons!.ideas[j] : undefined
  }
  if (key.type === 'pick') return key.ideas?.[key.choices.indexOf(answer)] || undefined
  return undefined
}

/**
 * The wrong idea a wrong move answer shows, worded as a misconception. The element comes
 * from the verified move ("Shunt C: z …"), not the question text, which models word freely.
 */
export function wrongMoveIdea(facts: string, picked: string, right: string): string {
  // "Shunt C" → "shunt C": lower-case the word, keep the component letter.
  const el = (facts.split(':')[0] || 'that element').replace(/^\w+/, (w) => w.toLowerCase())
  const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
  return /^It /.test(picked)
    ? `Thinks that after a ${el}, ${lc(picked)} (${lc(right)})`
    : `Thinks a ${el} moves the point ${lc(picked)} (it moves ${lc(right)})`
}

/**
 * "I'm not sure": ask for help instead of guessing. The card stays open (a tutor keeps the
 * question on the table while helping); a graded answer after help counts as partly theirs.
 */
export function unsureQuestion(): void {
  const p = useStudio.getState().prediction
  if (!p || useTutor.getState().busy) return
  if (p.key && !p.helped) useStudio.getState().setPrediction({ ...p, helped: true })
  useTutor.getState().send(`[${p.key ? 'Question' : 'Prediction'}] Q: ${p.question}\nMy answer: I'm not sure; help me reason about it.\n[The card stays open on their screen; they'll answer it there after your help. Don't re-send it, and don't give its answer: help them reason toward it.]`, {
    learnerAction: true,
    display: "I'm not sure, help me reason about it"
  })
}

/**
 * "Show values" on a covered reading question: the numbers come back, and the answer will count
 * partly (reading.ts). The tutor hears it with their answer, not now: nothing to reply to yet.
 */
export function revealValues(): void {
  const st = useStudio.getState()
  const p = st.prediction
  if (!p || p.values !== 'covered' || p.revealed) return
  st.setPrediction({ ...p, revealed: true })
  st.logEvent('prediction', 'Uncovered the values on a reading question')
}

/** Skip the question entirely; the tutor moves on. */
export function skipQuestion(): void {
  const p = useStudio.getState().prediction
  if (!p) return
  useStudio.getState().setPrediction(null)
  useTutor.getState().send(`[Question skipped] The learner skipped "${p.question}". Don't ask it again or quiz them on it; carry on with the lesson.`, {
    learnerAction: true,
    display: 'Skipped the question'
  })
}
