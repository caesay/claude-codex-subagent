---
name: codex
description: Run a task on an OpenAI Codex agent (GPT models such as
  gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna) from any context — main
  conversation, subagent, or workflow step. Covers launching, waiting without
  hanging, resuming threads, the <payload> ... </payload> prompt-wrapping
  contract for dispatching to the codex-runner relay, and the mandatory
  report-back contract.
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

### 2. Launch

New thread:

```
node <skill-dir>/run-codex.mjs --out <out> --prompt-file <out>/prompt.md --ceiling-min 30 -- exec -s workspace-write -m gpt-5.6-sol -c model_reasoning_effort=medium --skip-git-repo-check --ignore-user-config -C <cwd> -
```

Resume an existing thread (`resume` accepts NO `-s` or `-C` — sandbox must be
passed as a config override):

```
node <skill-dir>/run-codex.mjs --out <out> --prompt-file <out>/prompt.md --ceiling-min 30 -- exec resume <threadId> -c sandbox_mode="workspace-write" -c model_reasoning_effort=medium --skip-git-repo-check --ignore-user-config -
```

Knobs:
- model: `-m gpt-5.6-sol` (default frontier) | `gpt-5.6-terra` | `gpt-5.6-luna`
  (fast/cheap) | `gpt-5.5`. Omit `-m` for the user's default.
- effort: `-c model_reasoning_effort=low|medium|high|xhigh|max` (ultra exists
  on sol/terra).
- sandbox: `read-only` | `workspace-write` | `danger-full-access` (only when
  explicitly requested).
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
  model: <model>  effort: <effort>  sandbox: <sandbox>
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

## Use from workflows and subagents

Workflow steps and the Agent tool use the relay agent
`codex-subagent:codex-runner` (Sonnet), which follows this skill. Pass Codex
parameters as leading header lines in the task, then a blank line, then the
prompt:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   '<payload>',
   'Review src/ for concurrency bugs; report findings with file:line.',
   '</payload>'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
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

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-sandbox:`,
`codex-cwd:`, `codex-ceiling-min:`. From the main conversation you do not need
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
