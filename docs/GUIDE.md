# Smith Chart Tutor: the full guide

Everything the app does and how it decides, in detail. For an overview, see the [README](../README.md).

A desktop Smith chart with an agentic AI tutor. The chart shows every metric (Z, z, Y, y, Γ, VSWR, return loss, mismatch loss, Q, WTG/WTL, equivalent L/C) on hover and at target-frequency markers. The tutor watches what you do on the chart, sets exercises, remembers your progress across lessons, and works with any LLM.

**Reading the chart:**
- **Zoom:** scroll on the chart to zoom around the cursor, and drag to pan once zoomed.
- **Chart buttons (top right):**
  - **＋ / －** zoom in and out.
  - **⌖ Focus** frames your load, input, markers and matching path.
  - **Fit** shows the whole chart again.
  - **A− / A+** set the size of text and dots. The setting is remembered.
- Text and dots keep their on-screen size while you zoom, so crowded spots spread out. When zoomed in, resistance and reactance values are labelled near the middle of the view.
- Points that sit on the same spot share one label (e.g. "M1 · IN"), and no labels overlap.
- **Frequency band** (tick box in the chart legend and the Frequency panel): off, the chart shows the design frequency only. On, it adds the sweep traces, markers and bandwidths. A fixed load starts with it off, since a fixed impedance is the same at every frequency. Antennas, RLC loads and imported data start with it on.

## Run

Most people should use the one-click start: extract the ZIP and double-click `Start-Windows.cmd`, `Start-Mac.command` or `Start-Linux.sh` (see the [README](../README.md#getting-started)). It needs no admin rights: a private Node.js goes into `.runtime/` in the app folder, then [scripts/launch.mjs](../scripts/launch.mjs) installs, builds and starts the app, redoing a step only when its inputs changed. `--no-launch` stops before starting the app.

For development:

```bash
npm install
npm run dev        # development, hot reload
npm run build && npm start
npm test           # RF engine, importers, solver, assessment key, tool-arg coercion
```

> Running from a VS Code terminal? VS Code sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. Unset it first (`$env:ELECTRON_RUN_AS_NODE=$null` in PowerShell, `unset ELECTRON_RUN_AS_NODE` in bash).

## First steps

Everything leads to a **lesson** with the tutor. Until your first one, a *Get started* bar on every tab shows where you are and a button for the next step:

1. **Profiles**: set your name, experience, goals and tutor style.
2. **Placement test**: 21 questions (graded exactly, not by the LLM) that set your starting level per skill. You can skip it and let the tutor gauge you.
3. **Models**: add a *connection* (Anthropic, Google Gemini, OpenAI, OpenRouter, Ollama, LM Studio or any OpenAI-compatible endpoint), paste its one API key, and tick the models you want from the list that key can use. Run the benchmark on any of them.
4. **Learn**: press **▶ Start lesson**. Pick the tutor's suggestion, a skill, or your own question. The tutor sets a goal with 2–4 steps, which you see as a checklist above the chat, and starts step 1 straight away. It ticks off each step once *you* have done it.

**How a lesson ends:**
- **When you reach the goal,** the tutor closes the lesson itself. It's saved, and you see what you can now do, how your skill estimates moved, and what to practise next.
- **Finish early** saves it as *partly done*. The next lesson picks up from there.
- **Leave** appears if you haven't answered anything yet. That lesson isn't saved or counted.
- **Closing the app** only pauses a lesson.

After that, **▶ Start lesson** sits in the top bar on every tab. While a lesson is running, the top bar shows "Lesson N · step 2 of 3" and a way back to it. There's no clock: a lesson ends at its goal. On Progress, **Practise** starts a lesson on one skill. Once you have earlier lessons, you can tick **Start with a quick review question**: one question on past material, skippable, off by default and remembered once you tick it.

## Models and the benchmark

Keys belong to **connections** (one per provider account), not to models: one Anthropic key covers every Claude model. Temporary API errors (overload, per-minute rate limits) are retried automatically; daily or free-tier quotas fail fast with a clear message; model refusals are reported instead of showing an empty reply.

Three adapters cover most providers: Anthropic, OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM…) and Gemini. LLM calls run in the main process, so keys never reach the page. Reasoning models' `<think>` blocks are hidden from the chat.

### Free local tutor (Ollama)

The card at the top of the Models tab sets up a local tutor in one click, with no admin rights. The code is in [localModels.ts](../src/shared/localModels.ts) and [ollama.ts](../src/main/ollama.ts).

1. **It checks this computer.**
   - It reads the memory, and the GPU's memory: NVIDIA through the driver's `nvidia-smi`, while Apple Silicon shares the RAM and about two thirds of it is usable.
   - It looks for an Ollama that's already running or installed, including the app's own copy.
2. **It recommends a model.** The candidates are the local models that did best on the tutor benchmark, using the scores shipped with the app:
   - **qwen3:8b** when about 7 GB of GPU memory is free
   - **qwen3:1.7b** when there's about 3 GB, or when it has to run on the processor
   - none, with an honest pointer to cloud models, for machines with under 8 GB of memory and no usable GPU

   The reason is shown in plain words, and a smaller model is always one click away.
3. **It sets it up.**
   - **Ollama:** if there's no Ollama, it downloads the official standalone build for this OS into the per-user local app-data folder (on Windows `%LOCALAPPDATA%\SmithChartTutor\ollama`, not the roaming profile). The download is checked against Ollama's published checksum.
   - **Running it:** the app starts it when the app opens, and again whenever a lesson or the model list needs it (for example after it was closed from its tray). The app stops its own copy, with the model runner, when it closes. It never stops an Ollama you run yourself.
   - **One setup at a time:** the setup keeps going if you switch tabs, and a second one waits until the first finishes. A model download that won't fit on the disk is stopped before it starts, and a very slow machine gets a *slow* verdict rather than an error.
   - **The model:** it downloads the model with a progress bar. Downloads go through Electron's network stack, so the system proxy and company certificates apply.
4. **It measures this machine.**
   - It loads the model once, which is timed separately because it happens once per session.
   - It asks two short tutor questions and averages how long the answer takes to start (thinking included, because the learner waits for it) and how fast it streams.
   - It reads how much of the model sits on the GPU.
   - The verdict is *comfortable*, *usable, with some waiting*, or *slow*. Slow offers the smaller model or a cloud model.
5. **It adds the model** under an Ollama connection, with **Use as tutor**.

**Run benchmark** (or **Benchmark all** on a connection) runs 18 checks, all graded by code (no LLM judge). Each attribute matches a job the model does in the tool:

| Attribute | Used for | Example checks |
|---|---|---|
| Guiding | Socratic tutoring | withholds component values, corrects "series L goes counter-clockwise", short hints |
| Tool use | the agent loop | right tool and arguments, reads the chart before answering, converts nH/pF to SI, waits after a prediction card, no tool calls for small talk |
| RF knowledge | explanations | 12 concept questions (moves, λ/2, Foster, Q vs bandwidth, stubs, V_min…) |
| RF maths | numbers without the calculator | 6 calculations (weighted low; the tutor uses tools) |
| Learner tracking | your profile | records a wrong answer correctly, doesn't invent evidence |
| Summaries | the tutor's memory | key facts in under 110 words |
| Speed | responsiveness | first visible token, tokens/s |

**Compare models** (bottom of the Models tab) puts these in one table:

- Reference results that ship with the app
- Every model you've benchmarked, including deleted ones
- A model being tested right now, filling in live

Tick the attributes that matter to you, or pick a use case (Socratic coaching, Quick drills, Accuracy…). The ranking re-weights to those attributes only. The model you're testing is highlighted with its rank, untick a model to hide it, and hover any score to see what was tested.

Benchmark from the command line (keys stay encrypted in the app's store):

```bash
# all configured models, or a comma-separated list of provider ids/labels
SMITH_BENCH=all SMITH_MACHINE="RTX 5070 Laptop, Ollama" npx electron .
# debugging: list the models each saved key can use, or send one prompt to a model
SMITH_LIST_MODELS=1 npx electron .
SMITH_PROBE="Claude Sonnet 5.5" SMITH_PROMPT="Say hi" npx electron .
# refresh the shipped reference set from one or more settings.json files
node scripts/export-reference.mjs "%APPDATA%/smith-tutor/data/settings.json"
```

## CST / measured data

- **Best:** in CST, *Post-Processing → Import/Export → Touchstone* → `.s1p` / `.s2p` (S11 is used; S22 can be selected in code).
- **Also works:** *1D Results → S-Parameters → (right click) Export → Plot Data (ASCII)*. This needs **complex** data: Real/Imag, or Magnitude and Phase. A magnitude-only (dB) export can't be placed on a Smith chart; the importer explains this. Files with several parameter-sweep blocks become one dataset per block. If the column format is guessed wrong, change it in the Load panel.

## Calculator and formulas

The **Calculator** panel (under the matching network) does the arithmetic that goes with reading the chart, at the design frequency and Z0. It shows its working as typeset formulas with your numbers put in:

- **Convert:** one point as Z, z, Y, y, Γ, VSWR, return loss and Q (type it, or take the load, the input or a clicked point).
- **Component:** the L or C that adds a reactance (series) or susceptance (shunt), or the part that moves the point from one spot to another. It warns when one part of that kind can't make the move (r or g would have to change). "Add to network" puts the part on the chart.
- **Network:** what each element of your network does to z, step by step. Hovering a step highlights its path on the chart.

The tutor can open it filled in (`show_calculation`) to walk you through a calculation, and it sees what you calculated. To keep graded work fair, the converter pauses while a "read this value" question is open, and the tutor can't fill the calculator in during a graded question. There is no "solve the whole match" button.

The tutor's messages typeset LaTeX formulas too (`$…$` inline, `$$…$$` on their own line). Formulas use [KaTeX](https://katex.org), bundled with the app, so this works offline.

## The tutor is agentic: adding tools

The tutor decides for itself which tools to use; nothing is scripted. Every file in [src/renderer/src/agent/tools/](../src/renderer/src/agent/tools/) that default-exports `defineTools([...])` is picked up automatically:

```ts
import { defineTools } from '../types'
export default defineTools([{
  name: 'my_tool',
  description: 'When and why the tutor should use this.',
  parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  activity: () => 'Doing my thing',      // shown in the chat
  endsTurn: false,                        // true = learner acts next (like an exercise card)
  run: (args, ctx) => ({ result: args.x * 2 })  // ctx: chart store, derived metrics, profile
}])
```

Current tools:

- **Chart:** `get_chart_state`, `set_scenario`, `edit_network`, `annotate_chart`, `clear_annotations`, `focus_chart`
- **Exact maths:** `rf_calculate`, `what_if`, `solve_l_match`, `analyze_sweep`
- **Teaching:** the tutor designs its own tasks and questions. The app works out each right answer, refuses impossible tasks, and grades exactly:
  - `create_exercise`: match a load to a VSWR target, optionally across a band
  - `create_target_task`: get the point onto a spot or a circle (g = 1, the real axis, z = 1 + j1…) with limited elements; it can continue from your network
  - `ask_move`: which way, and along which circle, one element moves the point, or which half it ends in (multiple choice)
  - `ask_locate`: click a spot on the chart (a given z or y, or where an element takes the point)
  - `ask_value`: read or work out one number (VSWR, return loss, |Γ|, angle of Γ, z, y, Z, Y, Q, WTG), graded within ±5% with sensible minimums
  - `ask_component`: which part and what value adds a given x or b (or makes a given move). The learner types it with its unit ("2.7 nH"), and the unit says which part they chose. Graded within ±5%; a forgotten 2π, a missed de-normalisation and L/C swapped are recognised as slips.
  - `ask_spot_error`: a worked L-match with one planted mistake, or none (see below)
  - `ask_prediction`: open-ended predictions (not graded)
  - `check_exercise`, `close_exercise`
- **Lessons:** `set_lesson_goal`, `advance_lesson_step`, `set_lesson_coordinates`, `complete_lesson`
- **Learner model:** `get_learner_profile`, `record_evidence`, `set_skill_level`, `log_misconception`, `resolve_misconception`, `save_note`, `forget_note`

### Guardrails that work with any model

- Tool arguments are coerced to their schema types.
- Learner-model updates are refused until the learner has actually done something, with at most one update per skill per turn.
- An exercise, task or question card ends the tutor's turn.
- **Solve, then explain.** When you pass a task, the tutor gets your network with each move verified, and must ask one follow-up about your own solution before closing the task or the lesson. If it only praises you, it's reminded once. Follow-ups are marked optional, and every graded question can be skipped. You see ✓ or ✗; the exact answer goes to the tutor, which guides you to it instead of just telling you.
- Repeated tool loops are capped.
- An empty reply gets one nudge.
- Grading and maths are always exact; the LLM never grades.
- **Every chart move is verified before it's explained.**
  - `what_if` returns exact move facts for each element:
    - the circle it follows (constant r, constant g, or around the centre)
    - which way it turns, and by how many degrees
    - the start and end chart half, in both impedance and admittance terms
    - where it crosses the real axis
  - If the tutor states a direction, chart half or arc without having called `what_if` that turn, the reply is withdrawn before any of its actions run. The tutor must then verify and restate it. Questions to the learner don't count as claims.
- **Coordinates are never assumed.** Each step records whether it reads the chart as impedance or admittance. If the tutor doesn't say, the app infers it from the step's wording, and only on strong evidence. Otherwise it's *unknown*, and every direction claim is withdrawn until the tutor sets it. Lessons saved before this existed are inferred the same way when they load (for example, a shunt-C step that talks about y = 1.15 − j0.77 resolves to admittance).
- **Frequency only when it matters.** Giving the tutor's scenario a load starts a fresh setup, so markers, the sweep and the tutor's drawings from the previous setup don't carry over. The band stays hidden for one-frequency topics. The tutor turns it on only for bandwidth, Q or a frequency-dependent load, and gives a reason. An exercise graded across a band turns it on and marks the band edges.
- **The lesson state survives a model switch.**
  - The goal, steps, current step, coordinates (impedance, admittance or unknown) and sign convention are part of every system prompt.
  - Switching models mid-lesson is announced in the chat.
  - Each reply records the model that wrote it, and Progress shows it in the transcript.

## Profiles and history

Each profile stores:

- Per-skill mastery and confidence, with history
- Per-topic results (see below)
- Misconceptions
- The tutor's own notes about you
- Session transcripts and summaries
- The placement result
- Its own chart workspace

### Where you stand (Progress)

The Progress page shows the learner against two targets, defined in [src/shared/standing.ts](../src/shared/standing.ts):

- **Strong (75%):** right every time at medium difficulty. Steady medium answers approach 80% but never reach it, so the mark sits at 75%, about 8–10 steady right answers from a typical start.
- **Top (95%):** right at the hardest level too. Only hard answers get there.

The targets come from how the app grades, not from other learners. The page has four parts:

- **Overall:** your level, an overall scale with both targets marked, and one square per skill that turns blue at strong and green at top.
- **Work on next:** the tutor's plan (see below). Each card shows the tutor's reason, followed by the facts for that skill: the topic it chose, misconceptions, reviews due, and the gap to strong.
- **Skills:** one bar per skill with the two target lines and a shaded "how sure" range that narrows with evidence. A skill whose prerequisites are measured and weak shows a lock. A self-reported starting guess locks nothing.
- **Topics:** one square per topic, coloured by how it's going (not tried, shaky, building, strong, top), with ↻ when a review is due.

**How the app judges what you know.** A high score has to be earned with proof, so the number can't run ahead of the understanding:

- **Answers count for what they prove.**
  - A right pick from k choices is discounted by the chance of guessing it (1/k), and a two-part question counts as one pick from all the combinations.
  - Clicks, typed values and tasks count fully.
  - Right after talking it through with the tutor, or after several Checks, counts as partly right.
- **Judgement can't make a skill strong.** The placement test, the tutor's `record_evidence` (half weight) and its `set_skill_level` override all stop at 60%. Older profiles were brought into line once: a skill with no graded answers behind it came down to 60%.
- **Strong needs proof.** That means right answers on your own, in two lessons, at medium level or harder, in two different situations; top needs the hardest level. Until then a skill above 75% is "provisional", and the page says what proof is missing.
- **How sure you were, in the same click.** On a graded question, where you click an answer says how sure you are: the left third is guessing, the middle not sure, the right third sure. A meter along each button fills and a tag names the zone as you move. Two-part questions carry it on the reason; click and typed answers carry it on Submit. There is no extra step. A keyboard answer (Enter) records no confidence.
  - Right but unsure counts less, isn't proof, and comes back for review soon.
  - A right guess counts as partly right.
  - Wrong but sure is flagged as a real misconception and goes to the top of the tutor's list.
  - A wrong guess is a gap, not a misconception.
  - "How well you judge yourself" on Progress shows how often you're right when sure, unsure and guessing, so you can see whether you're under- or overconfident.
- **Questions that dig:**
  - Move questions ask why as well as which way. Picking the right direction for the wrong reason counts as partly right and records the wrong idea.
  - `ask_spot_error` shows a worked L-match with one realistic planted mistake, or none: an inverted normalisation, the wrong direction or circle, the wrong part for the sign, or a forgotten 2π.
  - Every item records its situation (which half, which side of r = 1, which quantity), and a topic is solid only once it has been right in two.
  - After each answer the app tells the tutor to probe one level up or down, to find your ceiling and floor quickly.
- **Check yourself** (on Progress, or in the lesson launcher) is a short session of graded questions with no teaching. It targets the skills with the least proof, then gives an honest summary from the results.

**Patterns: the same confusion, noticed over time** ([src/shared/patterns.ts](../src/shared/patterns.ts)). The app knows every right answer exactly, so it can tell how an answer is wrong. It never guesses: an answer that is wrong in no recognisable way leaves no trace, and neither does a wrong guess.

- **What counts as a recognisable mistake:**
  - **Clicks:** a click mirrored through the centre is the admittance point; the other half means a flipped sign; swapped r and x.
  - **Typed values:** |Γ| given for VSWR, radians given for degrees, y given for z, a value never normalised, a forgotten 2π.
  - **Move questions:** the wrong circle or the wrong way, and what a wrong reason shows.
  - **Spot the mistake:** which planted mistake they accepted.
- **Each one maps to one of 11 underlying confusions,** such as z vs y, series vs shunt, rotation, sign, normalisation, 2π, |Γ| vs VSWR, and line direction or motion.
- **The record:** it keeps each mistake as a "slip" (up to 150). The tutor adds what it hears in conversation through `log_misconception`'s `confusion` field.
- **The pattern lifecycle:**
  - The same confusion in **two topics or two lessons** is a pattern.
  - It **fades** after a lesson of clean answers on its topics, and is **gone** after two.
  - A new slip brings it back.
  - The status is worked out from the record each time, so it can't drift.
- **What the tutor gets:**
  - "NEW PATTERN" / "PATTERN BACK" in the result of the answer that triggered it.
  - The live patterns at the top of its brief, with the root idea and the questions to check it with.
  - The pattern listed as a reason in the "candidates by the numbers".
- **On Progress,** "Patterns the tutor has noticed" shows each pattern with the idea behind it and its evidence.

**Who picks what's next: the tutor, in one place.** The app never picks for the learner. Two single sources keep every screen consistent:

- **The facts** come from [standing.ts](../src/shared/standing.ts) and `topicState` in [memory.ts](../src/shared/memory.ts): the targets, each skill's gap or lock, how each topic is going, and the "candidates by the numbers". The Progress page draws them, and the tutor reads the same facts in its instructions. If something is judged wrong, it's fixed there, once.
- **The decision** is the tutor's `set_next_focus`: 1–3 skills (optionally a topic in each), each with a reason, saved on the profile. The Progress page ("Work on next"), the lesson launcher ("in your tutor's plan") and the tutor's own next lesson ("Tutor's pick") all read it.

The tutor may disagree with the candidates when it has a reason. The app holds it to one rule: no skill whose measured prerequisites are weak. It sets the plan at the end of every lesson; `complete_lesson` asks for it once, without blocking a model that won't.

### The tutor's memory of you

The app keeps it, so it's the same whichever model teaches, and it stays small however long you use the app.

- **Graded answers update it automatically.** Every task and graded question is filed under a specific topic, such as "which way a shunt C moves the point" or "|Γ|, VSWR and return loss". There are 22 topics under the 9 skills. The app also sets each item's difficulty (1–3) from the task itself. One answer moves:
  - the skill estimate, by a fixed rule
  - the topic's counts
  - the topic's **aim level**: two right in a row at the edge of your level steps it up; a miss at or below it steps it down; easy items don't move it
  - the topic's **next review date**: tomorrow after a miss, then 3, 7, 14 and 30 days as you keep getting it right

  The tutor can't record the same answer again. Its own `record_evidence` is for what can't be graded, such as explanations and reasoning.
- **Misconceptions are tied to topics.** A wrong pick on a move question records exactly which wrong idea it shows. A misconception closes by itself after right answers in **two separate lessons**, and reopens if you slip again. Older ones get their topic from their wording.
- **Notes are few and categorised:** goal, preference, what clicked, struggle, other. At most 5 are kept per category. A near-duplicate replaces the older note; the tutor can update or delete notes, and so can you, on Progress.
- **The tutor plans from a short brief.** It's rebuilt every turn and bounded in size:
  - your goals
  - each skill's level, trend and aim level
  - weak topics, topics due for review, and solid topics
  - live misconceptions
  - the last items asked, so they aren't repeated
  - notes and the last few lessons

  The tutor picks the area (reviews and misconceptions first, then weak topics, then the lesson goal), pitches at the aim level and varies the form. Transcripts are kept for you to read, but the tutor no longer reads old ones.
- **Progress** shows each skill's topics: how often you got them right, the next aim level, and whether a review is due.

**Export** saves the whole profile (history included, API keys never) to a file for backup or moving to another PC; **Import** brings it back.

### What is saved, and when

Everything saves automatically, per profile, and survives tab switches, profile switches and restarts.

| What | When it saves | File |
|---|---|---|
| Placement test in progress | after every answer; resume from Placement test or the Get started bar | `profiles/<id>.json` |
| Chart setup, exercise card, prediction card, the tutor's drawings | as you change them | `workspaces/<id>.json` |
| Live tutor conversation | while you talk; restored on the next launch | `conversations/<id>.json` |
| Session transcript and exercises | after every turn | `profiles/<id>.json` |

Ending a lesson (by reaching the goal or finishing early) writes a summary for the tutor's memory. Lessons you never ended are summarised automatically when you next start one.

**Long lessons.** The tutor model sees the last 60 messages. As older ones fall out of view, the app folds them into running notes for the lesson ("Learner told me: …", what was taught, what you asked and got wrong). The notes are written in the background after a turn, oldest first, and keep every fact you gave about yourself or your project. The tutor gets them on every turn, and the end-of-lesson summary is built from them, so the start of a three-hour lesson isn't forgotten. Other limits that keep a long lesson fast:
- The chat panel draws the latest 150 messages; *Show earlier messages* adds more.
- A very long paste, such as a data file, reaches the model shortened. Import measured data from the Load panel instead.
- A lesson stores its latest 2000 messages, each up to 4000 characters, along with the true message count. Lessons older than the last 20 keep their summary and last 20 messages.

Data folder (plain JSON): `%APPDATA%/smith-tutor/data/`. Profiles → *Open data folder*.

## Layout

```
src/shared/rf/        complex maths, metrics, networks & loads, solvers, Touchstone/CST importers (+ tests)
src/shared/           llm types, profile/skill model, assessment bank, benchmark
src/main/             Electron main: window, storage, encrypted keys, LLM adapters (anthropic/openai/gemini)
src/preload/          safe IPC bridge (window.api)
src/renderer/src/     React UI: chart/, panels/, views/, state/, agent/ (loop, prompt, registry, tools/)
```
