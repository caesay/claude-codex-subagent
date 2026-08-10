# codex-subagent

Claude Code plugin that runs OpenAI Codex (GPT models) as a subagent via the
`codex exec` CLI, supervised by a small watchdog runner. Zero dependencies,
no build step, no daemon.

## What you get

- **`codex` skill** — the full procedure for launching a Codex agent from any
  context (main conversation, subagent, workflow step): model/effort/sandbox
  selection, thread resume, hang-proof waiting, and a mandatory report-back
  contract.
- **`run-codex.mjs` watchdog** — one short-lived process per call. Enforces a
  wall-clock ceiling and stall detection (tree-kill), captures the thread id,
  and always writes `result.json`. Exit 0 only when Codex exited 0 AND
  produced a non-empty final message.
- **`codex-runner` agent** — thin Sonnet relay so Workflow (ultracode) steps
  can be assigned to Codex models.

## Why this shape

OpenAI's own `codex-plugin-cc` accumulated 30+ open hang/no-result issues.
The recurring causes, which this design counters directly:

| Failure there | Counter here |
|---|---|
| Relay returns "running in background..." stub, result never collected | Hard rule: never finalize before reading `result.json`; harness-tracked background only |
| Completion promise never bounded; jobs wedge at `running` forever | Watchdog wall-clock ceiling + stall kill, always-written `result.json` |
| Detached workers tree-killed or orphaned by the harness | No detaching, ever; one foreground/tracked process per call |
| `exit 0` treated as success with zero output | Empty final message = error, loud `CODEX-ERROR:` contract |
| Stale shared broker / app-server reused while wedged | No daemon at all |
| Inherited user MCP servers hang startup | `--ignore-user-config` |

## Prerequisites

- Node.js ≥ 18
- `npm install -g @openai/codex` (tested against codex-cli 0.144.5)
- `codex login`

## Install

```
claude --plugin-dir C:\Source\claude-codex-subagent
```

## Use

Direct (main conversation): invoke the `codex-subagent:codex` skill and follow
it. Workflow step / subagent:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   'Review src/ for concurrency bugs and report findings.'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
// follow-up: extract threadId from the ---codex--- footer,
// pass 'codex-thread: <id>' as a header in the next step
```

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-sandbox:`,
`codex-cwd:`, `codex-ceiling-min:`.

Results end with a grep-able footer:

```
---codex---
threadId: 019876ab-...
model: gpt-5.6-terra  effort: high  sandbox: read-only
duration: 184032 ms
```

Failures are always reported as `CODEX-ERROR: <reason>` with the threadId for
resume — never silence.

## CLI notes

- The watchdog spawns the native codex binary directly (npm shims are
  unreliable with piped stdio on Windows); override with `CODEX_EXECUTABLE`.
- Prompts are piped via stdin (`-`), never inlined as shell arguments.
- `codex exec resume <threadId>` accepts no `-s`/`-C`; sandbox on resume goes
  via `-c sandbox_mode="..."`.

## Test

```
node test/smoke.mjs   # happy path, thread resume, ceiling kill (few tokens)
```
