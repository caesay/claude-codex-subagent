---
name: codex-agent
description: Run a task on an OpenAI Codex agent (GPT models) from any context —
  main conversation, subagent, or workflow step. Recommended models, in
  descending capability — gpt-6-astra is the frontier model, for the most
  complex tasks needing the highest intelligence; gpt-5.6-sol is the workhorse
  and the default choice, high capability, smart, quick and cost-effective;
  gpt-5.6-terra is mid-tier and balanced, for document analysis, text
  generation, code exploration and other low-stakes work; gpt-5.6-luna is
  small, fast and cheap, to be avoided for coding but suited to routine
  high-frequency automation such as high-volume classification or locating
  something in a large codebase, with the understanding of what was found
  deferred to a higher tier. Covers
  launching, waiting without hanging, resuming threads, the <payload> ...
  </payload> prompt-wrapping contract for dispatching to the codex-runner
  relay, and the mandatory report-back contract.
---

# Running a Codex agent

Codex runs as a one-shot CLI process supervised by the watchdog script
`run-codex.mjs` that lives **next to this SKILL.md**. There is no daemon.
The watchdog enforces a wall-clock ceiling and stall detection, and always
writes a machine-readable `result.json` — do not bypass it by calling
`codex` directly.

## Procedure

### 1. Prepare

Create a unique output directory `<out>` under your scratchpad (e.g.
`<scratchpad>/codex/<task-slug>/`). Write the full task prompt to
`<out>/prompt.md` with the Write tool — self-contained: task, relevant paths,
what the final message must contain. If the prompt arrived wrapped in
`<payload>` ... `</payload>`, strip those tags and write the rest byte for
byte. Concurrent Codex calls are fine as long as each has its own `<out>`.

**Codex always runs unsandboxed — say what it may touch.** There is no sandbox
option; see *No sandbox* below. Nothing stops Codex writing outside the paths
you had in mind, so the prompt is the only boundary that exists. Name the
directories it should change, and say plainly when something is off limits
("read `../other-repo` but do not modify it", "do not push", "do not touch
anything outside `src/`"). You do not need to grant permissions — it already has
all of them — you need to withhold them.

The runner prepends a short `<runtime>` block telling Codex there is no sandbox
and where its scratch directory is, so you never have to. It writes what Codex
actually received to `<out>/prompt-sent.md`.

### 2. Launch

New thread:

```
node <skill-dir>/run-codex.mjs --out <out> --prompt-file <out>/prompt.md --ceiling-min 30 -- exec -m gpt-5.6-sol -c model_reasoning_effort=medium --skip-git-repo-check --ignore-user-config -C <cwd> -
```

Resume an existing thread (`resume` accepts no `-C`):

```
node <skill-dir>/run-codex.mjs --out <out> --prompt-file <out>/prompt.md --ceiling-min 30 -- exec resume <threadId> -c model_reasoning_effort=medium --skip-git-repo-check --ignore-user-config -
```

Knobs:
- model: `-m <model>`, or omit `-m` for the user's default. Pick by what the
  task actually needs — this is the main cost/quality lever you control:

  | Model | Use it for |
  |---|---|
  | `gpt-6-astra` | Frontier. The most complex tasks, where the highest intelligence is what the job requires. |
  | `gpt-5.6-sol` | Workhorse, and the default. High capability, smart, quick, cost-effective. Reach here unless you have a reason not to. |
  | `gpt-5.6-terra` | Mid-tier, balanced. Document analysis, text generation, code exploration, other low-stakes work. |
  | `gpt-5.6-luna` | Small, fast, cheap. **Avoid for coding.** Routine high-frequency automation — high-volume classification, or finding where something lives in a large codebase, with the understanding of what was found deferred to a higher tier. |

- effort: `-c model_reasoning_effort=low|medium|high|xhigh|max` (ultra exists
  on sol/terra).
- sandbox: there is no sandbox knob. Do not pass `-s`, `--sandbox`,
  `-c sandbox_mode=...`, `-c approval_policy=...` or `--approve-for-me` — the
  runner strips them. See *No sandbox*.
- scratch: `--scratch <dir>` — defaults to `<out>/scratch`, created by the
  runner and named to Codex in the preamble. Pin it to a stable path when
  resuming a thread that left a harness behind.
- ceiling: `--ceiling-min` — set to a generous bound for the effort level
  (30 for medium, 60 for xhigh+). Stall kill defaults to 10 min of silence
  (`--stall-min`).
- The trailing `-` is required (prompt is piped via stdin — never inline the
  prompt as a shell argument).
- Keep `--ignore-user-config`: it stops Codex inheriting the user's MCP
  servers, which is a notorious source of startup hangs.

### 3. Wait — without hanging and without lying

- Expected short (low effort, small task): run the command **foreground** with
  an explicit Bash `timeout` (e.g. 600000). Never rely on default timeouts.
- Expected long or unknown: run with `run_in_background: true` on the Bash
  tool. This is harness-TRACKED background — you will be re-invoked when the
  process exits. **Never** detach with `nohup`/`start`/`disown`/`&` — a
  detached process gets orphaned and its result is lost.
- If you end your turn while the background run is live, your last text MUST
  say so, e.g.: "Codex is running in the background; I will report its result
  when it finishes." (Callers see this if they peek — it prevents a premature
  "it silently failed" diagnosis.)
- Progress peek (optional, e.g. when the user asks): tail `<out>/events.jsonl`.
  Do not poll in a loop; the exit notification is the wake-up signal.

### 4. Report — mandatory contract

The runner's stdout is a single `RESULT: {...}` line carrying `ok`, `exitCode`,
`killed`, `reason`, `threadId`, `durationMs`, `lastMessageChars`, and the
`lastMessageFile` / `resultFile` paths. It deliberately does **not** carry the
final message — that keeps the payload out of your context until you ask for
it, and stops the same text being billed to context three times over.

Read the payload at most once, from the file, and only when it is small
enough to be worth carrying:

- `ok: true` and `lastMessageChars` <= 8000 (about 100 lines) — read `<out>/last-message.txt`
  (the `lastMessageFile` path). Your report is its contents verbatim,
  followed by this footer:

  ```
  ---codex---
  threadId: <threadId>
  model: <model>  effort: <effort>
  duration: <durationMs> ms
  out: <out>
  ```

  Do not also read `result.json` on success — it holds a second copy of the
  same message. Do not summarise, re-order, or clean up the message; it is
  the deliverable.

- `ok: true` and `lastMessageChars` > 8000 — do **not** read the file.
  Report the pointer, then the same footer:

  ```
  codex report: <out>/last-message.txt
  (<lastMessageChars> chars — read this file for the full result)
  ```

  Subagent and workflow replies are size-capped by the harness, so a long
  inline report is truncated in transit; and a report you inline is a report
  whose context you pay for twice. Whoever actually needs the text reads the
  file, once. This is why `lastMessageChars` is on the `RESULT:` line — you
  can choose the shape before the payload ever enters your context.

- `ok: false` → report `CODEX-ERROR: <reason>`, plus the last ~20 lines of
  `<out>/stderr.txt`, plus the threadId (if present) with the resume command so
  the caller can continue the thread instead of restarting.

Never read `<out>/events.jsonl` into your report. It is the full Codex
transcript and it exists so that it does *not* have to enter anyone's context.

Hard rules, each one a known failure mode of naive integrations:
- NEVER report success based on exit code alone — empty final message = error.
- NEVER end your final turn before the runner has exited and you have read its
  `RESULT:` line. A "Codex was started..." message is not a result.
- NEVER return nothing on failure — always the `CODEX-ERROR:` form.
- NEVER do the task yourself. If Codex cannot be reached — the skill will not
  load, `codex` is not installed, `run-codex.mjs` is missing, login is expired —
  the answer is `CODEX-ERROR: <what failed>`. Answering from your own knowledge
  instead is the single worst failure available here: the caller asked for a
  second opinion from a different model family and would silently get a first
  opinion twice.
- To cancel, send SIGTERM/SIGINT to the `node run-codex.mjs` process (on
  Windows use `taskkill /PID <pid> /T`, not `Stop-Process -Force`, so the
  runner can clean up). It kills the codex tree and still writes
  `result.json`. Report the interruption + threadId.

## No sandbox

The runner always appends `--dangerously-bypass-approvals-and-sandbox`, so Codex
has full filesystem and network access and never pauses for approval. **There is
no way to turn this off.** Sandbox and approval arguments supplied by a caller
are stripped before codex is spawned: `-s`, `--sandbox`, `--sandbox=`,
`-c sandbox_mode=...`, `-c approval_policy=...`, `--approve-for-me`. The runner
names what it dropped on stderr.

Three reasons, in the order they bite:

1. A caller-supplied sandbox flag alongside the bypass flag makes codex reject
   the invocation outright. Models kept supplying one, so the run simply failed.
2. A sandbox denial does not reach Codex as "you may not do that" — it arrives
   mid-run as a command that failed, which it then tries to work around, and the
   usual result is a burnt ceiling and a partial answer rather than a clean
   refusal.
3. Approval prompts have nothing to answer them in a non-interactive run, so the
   run sits until the stall timer kills it.

The cost is that **the prompt is the only boundary**. Write it that way:

- Name the directories Codex should change, not just the task.
- State the exclusions you actually care about — don't modify this dependency,
  don't push, don't touch anything outside this subtree, don't install
  globally. Absent a sentence, there is no restriction.
- Point mess at the scratch directory rather than forbidding it in the abstract;
  the preamble already offers one.

If a task genuinely must not write anything, say so in the prompt and ask for a
report rather than edits. That is now the only form the constraint can take.

## Use from workflows and subagents

Workflow steps and the Agent tool use the relay agent
`codexcs:codex-runner` (Sonnet), which follows this skill. Pass Codex
parameters as leading header lines in the task, then a blank line, then the
prompt:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   '<payload>',
   'Review src/ for concurrency bugs; report findings with file:line.',
   '</payload>'].join('\n'),
  { agentType: 'codexcs:codex-runner' })
// follow-up: const threadId = /threadId: (\S+)/.exec(result)[1]
// next task starts with 'codex-thread: <threadId>' header
```

**Wrap the prompt in `<payload>` ... `</payload>`.** The relay's failure mode
is reading the prompt as instructions addressed to *it* and doing the task
itself instead of dispatching — and the longer and more imperative the prompt,
the more it outranks the relay's own short role description. The tags mark the
text as inert data with a boundary, rather than arguing with it. They are
stripped before the prompt reaches Codex. An unwrapped prompt still works, but
it is the shape that has actually failed in practice.

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-cwd:`,
`codex-ceiling-min:`. There is no `codex-sandbox:` header — see *No sandbox*. From the main conversation you do not need
the relay — follow this skill directly.

**Verify the relay.** A `codex-runner` reply that does not end with a
`---codex---` footer (or a `CODEX-ERROR:` line) did not come from Codex — the
relay answered by itself, which is the one failure it is forbidden to have.
Treat such a reply as a failed step: discard it and re-dispatch. Do not use it.
A reply that opens with `codex report: <path>` is a large result, not a
failure: read that file when you need the text.

```js
if (!/---codex---|^CODEX-ERROR:/m.test(result)) throw new Error('relay did not run codex')
```
