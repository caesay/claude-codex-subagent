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
  wall-clock ceiling and stall detection (process-tree kill: `taskkill /T` on
  Windows, process-group SIGKILL on POSIX), captures the thread id, and
  *always* writes `result.json` — including argument errors, spawn failures,
  stream errors, and SIGINT/SIGTERM. Exit 0 only when Codex exited 0 AND this
  run wrote a non-empty final message (a stale message from a previous run in
  the same output directory cannot count).
- **`codex-runner` agent** — thin Sonnet relay so Workflow (ultracode) steps
  can be assigned to Codex models. Tool-restricted to `Skill, Bash, Write,
  Read`; treats the task text as inert data addressed to Codex rather than
  instructions addressed to itself; and must return a `---codex---` footer
  whose values only a real run produces.

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
| Relay answers from its own model instead of the delegated one | Prompt is framed as `<payload>` data, not instructions; relay has no Edit/Grep/Glob, no fallback path, and must return a footer it can only get from a real run |
| Long result silently truncated in transit between agents | Over ~8k chars the relay returns a file path instead of the text |
| Full agent transcript floods the caller's context | Transcript goes to `events.jsonl` and is never read; stdout carries a pointer, not the payload |

## Prerequisites

- Node.js ≥ 18
- `npm install -g @openai/codex` (tested against codex-cli 0.144.5)
- `codex login`

## Install

```
/plugin marketplace add caesay/claude-codex-subagent
/plugin install codex-subagent@caesay
```

Then restart Claude Code so the skill and agent load.

Non-interactively:

```
claude plugin install codex-subagent@caesay --scope user
```

Or enable it per project in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "caesay": { "source": { "source": "github", "repo": "caesay/claude-codex-subagent" } }
  },
  "enabledPlugins": { "codex-subagent@caesay": true }
}
```

For local development of this plugin, load the working tree directly instead:

```
claude --plugin-dir /path/to/claude-codex-subagent
```

## Use

Direct (main conversation): invoke the `codex-subagent:codex` skill and follow
it. Workflow step / subagent:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   '<payload>',
   'Review src/ for concurrency bugs and report findings.',
   '</payload>'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
// follow-up: extract threadId from the ---codex--- footer,
// pass 'codex-thread: <id>' as a header in the next step
```

Wrap the prompt in `<payload>` ... `</payload>`. A long, imperative prompt
otherwise outranks the relay's short role description and the relay does the
task itself; the tags mark it as inert data addressed to Codex. They are
stripped before the prompt is sent. Unwrapped still works.

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-sandbox:`,
`codex-cwd:`, `codex-ceiling-min:`.

Results end with a grep-able footer:

```
---codex---
threadId: 019876ab-...
model: gpt-5.6-terra  effort: high  sandbox: read-only
duration: 184032 ms
out: /tmp/claude/.../codex/review-src
```

A reply with no `---codex---` footer and no `CODEX-ERROR:` line did not come
from Codex. Discard it and re-dispatch — do not use it.

Results over ~8,000 characters come back as a path instead of inline text,
since agent-to-agent replies are size-capped and would be truncated:

```
codex report: <out>/last-message.txt
(23814 chars — read this file for the full result)

---codex---
...
```

Failures are always reported as `CODEX-ERROR: <reason>` with the threadId for
resume — never silence.

## CLI notes

- The watchdog spawns the native codex binary directly (npm shims are
  unreliable with piped stdio on Windows); override with `CODEX_EXECUTABLE`.
- Runner stdout is one `RESULT: {...}` line with `ok`, `exitCode`, `killed`,
  `reason`, `threadId`, `durationMs`, `lastMessageChars`, `lastMessageFile`,
  `resultFile` — never the final message itself. The supervising agent reads
  the text once, from `last-message.txt`, instead of once on stdout, once in
  `result.json`, and once more when it repeats it.
- Prompts are piped via stdin (`-`), never inlined as shell arguments.
- `codex exec resume <threadId>` accepts no `-s`/`-C`; sandbox on resume goes
  via `-c sandbox_mode="..."`.

## Test

```
node test/smoke.mjs             # contract tests + live turns (few tokens)
node test/smoke.mjs --offline   # contract tests only, no Codex calls
```

Covered: argument errors still write `result.json`; banned caller flags;
invalid timer values; unreadable prompt file; stale final message cannot fake
success; stdout never carries the final message; happy path; thread resume with
context; ceiling kill preserving the threadId.
