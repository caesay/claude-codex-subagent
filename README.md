# codexcs

Claude Code plugin that runs OpenAI Codex (GPT models) as a subagent via the
`codex exec` CLI, supervised by a small watchdog runner. Zero dependencies,
no build step, no daemon.

## What you get

- **`codexcs:codex-agent` skill** — the full procedure for launching a Codex agent from any
  context (main conversation, subagent, workflow step): model/effort/sandbox
  selection, thread resume, hang-proof waiting, and a mandatory report-back
  contract.
- **`run-codex.mjs` watchdog** — one short-lived process per call. Enforces a
  wall-clock ceiling and stall detection (process-tree kill: `taskkill /T` on
  Windows, process-group SIGKILL on POSIX), captures the thread id, and
  *always* writes `result.json` — including argument errors, spawn failures,
  stream errors, and SIGINT/SIGTERM. Exit 0 only when Codex exited 0 AND this
  run wrote a non-empty final message (a stale message from a previous run in
  the same output directory cannot count). It also composes the prompt Codex
  receives — see *Sandboxing* — and records it as `prompt-sent.md`.
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
| Sandbox denials surface mid-run as failed commands the agent works around; approval prompts stall a run nobody is watching | Unsandboxed by default, with the boundary moved into the prompt |
| Codex scatters harnesses, clones and build output through the working tree | Runner creates a scratch dir and names it in every prompt |
| Full agent transcript floods the caller's context | Transcript goes to `events.jsonl` and is never read; stdout carries a pointer, not the payload |

## Prerequisites

- Node.js ≥ 18
- `npm install -g @openai/codex` (tested against codex-cli 0.144.5)
- `codex login`

## Install

```
/plugin marketplace add caesay/claude-codex-subagent
/plugin install codexcs@caesay
```

Then restart Claude Code so the skill and agent load.

Non-interactively:

```
claude plugin install codexcs@caesay --scope user
```

Or enable it per project in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "caesay": { "source": { "source": "github", "repo": "caesay/claude-codex-subagent" } }
  },
  "enabledPlugins": { "codexcs@caesay": true }
}
```

For local development of this plugin, load the working tree directly instead:

```
claude --plugin-dir /path/to/claude-codex-subagent
```

## Use

Direct (main conversation): invoke the `codexcs:codex-agent` skill and follow
it. Workflow step / subagent:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   '<payload>',
   'Review src/ for concurrency bugs and report findings.',
   '</payload>'].join('\n'),
  { agentType: 'codexcs:codex-runner' })
// follow-up: extract threadId from the ---codex--- footer,
// pass 'codex-thread: <id>' as a header in the next step
```

Wrap the prompt in `<payload>` ... `</payload>`. A long, imperative prompt
otherwise outranks the relay's short role description and the relay does the
task itself; the tags mark it as inert data addressed to Codex. They are
stripped before the prompt is sent. Unwrapped still works.

Headers: `codex-model:`, `codex-effort:`, `codex-thread:`, `codex-sandbox:`,
`codex-cwd:`, `codex-ceiling-min:`.

Models worth routing between:

| Model | Use it for |
|---|---|
| `gpt-6-astra` | Frontier. The most complex tasks, where the highest intelligence is what the job requires. |
| `gpt-5.6-sol` | Workhorse, and the default. High capability, smart, quick, cost-effective. |
| `gpt-5.6-terra` | Mid-tier, balanced. Document analysis, text generation, code exploration, low-stakes work. |
| `gpt-5.6-luna` | Small, fast, cheap. Avoid for coding — it suits high-volume classification or locating things in a large codebase, deferring the understanding to a higher tier. |

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

## Sandboxing

**Codex runs unsandboxed by default.** The runner appends
`--dangerously-bypass-approvals-and-sandbox` unless the caller states a sandbox
of its own, so Codex has full filesystem and network access and never pauses for
approval.

A sandbox denial doesn't reach Codex as "you may not do that" — it arrives
mid-run as a command that failed, which it then works around, and the usual
outcome is a burnt ceiling and a partial answer rather than a clean refusal.
Approval prompts are worse: nothing is there to answer them, so the run sits
until the stall timer kills it. Both failure modes look like the plugin being
broken.

The trade is that the prompt becomes the only boundary. The skill instructs
callers to name the directories Codex may change and to state exclusions
explicitly — nothing is withheld unless a sentence withholds it. To confine a
run, pass a sandbox and the bypass is suppressed:

```
... -- exec -s read-only -m gpt-5.6-sol ... -            # review work
... -- exec resume <id> -c sandbox_mode="read-only" ... -  # resume takes no -s
```

Every prompt is prefixed with a short `<runtime>` block stating that there is no
sandbox and naming a scratch directory (`<out>/scratch`, or `--scratch <dir>`),
so Codex puts temp files, test harnesses, throwaway clones and build output
there instead of in the tree it was asked to reason about. `<out>/prompt-sent.md`
records exactly what Codex received.

## CLI notes

- The watchdog spawns the native codex binary directly (npm shims are
  unreliable with piped stdio on Windows); override with `CODEX_EXECUTABLE`.
- Runner stdout is one `RESULT: {...}` line with `ok`, `exitCode`, `killed`,
  `reason`, `threadId`, `durationMs`, `lastMessageChars`, `lastMessageFile`,
  `resultFile` — never the final message itself. The supervising agent reads
  the text once, from `last-message.txt`, instead of once on stdout, once in
  `result.json`, and once more when it repeats it.
- Prompts are piped via stdin (`-`), never inlined as shell arguments, and are
  prefixed with the `<runtime>` preamble described under *Sandboxing*.
- `codex exec resume <threadId>` accepts no `-s`/`-C`; sandbox on resume goes
  via `-c sandbox_mode="..."`.

## Test

```
node test/smoke.mjs             # contract tests + live turns (few tokens)
node test/smoke.mjs --offline   # contract tests only, no Codex calls
```

Covered: argument errors still write `result.json`; banned caller flags;
invalid timer values; unreadable prompt file; stale final message cannot fake
success; stdout never carries the final message; the runtime preamble, scratch
directory and `--scratch` override; caller-set sandbox suppressing the bypass;
happy path; thread resume with context; ceiling kill preserving the threadId.
