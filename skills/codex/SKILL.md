---
name: codex
description: Run a task on an OpenAI Codex agent (GPT models such as
  gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna) from any context — main
  conversation, subagent, or workflow step. Covers launching, waiting without
  hanging, resuming threads, and the mandatory report-back contract.
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
what the final message must contain. Concurrent Codex calls are fine as long
as each has its own `<out>`.

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

When the process exits, read `<out>/result.json`:

- `ok: true` → your report is the `lastMessage` value (or the contents of
  `<out>/last-message.txt`), followed by this footer:

  ```
  ---codex---
  threadId: <threadId from result.json>
  model: <model>  effort: <effort>  sandbox: <sandbox>
  duration: <durationMs> ms
  ```

- `ok: false` → report `CODEX-ERROR: <reason from result.json>`, plus the last
  ~20 lines of `<out>/stderr.txt`, plus the threadId (if present) with the
  resume command so the caller can continue the thread instead of restarting.

Hard rules, each one a known failure mode of naive integrations:
- NEVER report success based on exit code alone — empty final message = error.
- NEVER end your final turn before reading `result.json`. A "Codex was
  started..." message is not a result.
- NEVER return nothing on failure — always the `CODEX-ERROR:` form.
- To cancel, kill the `node run-codex.mjs` process — the codex tree dies with
  it. Report the interruption + threadId.

## Use from workflows and subagents

Workflow steps and the Agent tool use the relay agent
`codex-subagent:codex-runner` (Sonnet), which follows this skill. Pass Codex
parameters as leading header lines in the task, then a blank line, then the
prompt:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   'Review src/ for concurrency bugs; report findings with file:line.'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
// follow-up: const threadId = /threadId: (\S+)/.exec(result)[1]
// next task starts with 'codex-thread: <threadId>' header
```

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-sandbox:`,
`codex-cwd:`, `codex-ceiling-min:`. From the main conversation you do not need
the relay — follow this skill directly.
