# codex-subagent

Claude Code plugin that runs OpenAI Codex (GPT models) as a subagent through
the `codex app-server` JSON-RPC interface. Zero dependencies, no build step —
plain Node ESM.

## What you get

- **`CodexAgent` MCP tool** — launch a task on a Codex model
  (`gpt-5.6-sol`, `gpt-5.6-terra`, ...), pick reasoning effort, sandbox, and
  working directory; continue conversations across calls via `threadId`.
- **`CodexStatus` MCP tool** — auth status, model list, server health.
- **`codex-runner` agent** — thin relay so Workflow (ultracode) steps can be
  assigned to Codex models.
- **`codex-workflows` skill** — canonical usage patterns.

## Prerequisites

- Node.js ≥ 18
- `npm install -g @openai/codex` (tested against codex-cli 0.144.5)
- `codex login` (auth is reused from `~/.codex/auth.json`)

## Install

```
claude --plugin-dir C:\Source\claude-codex-subagent
```

or add the directory as a local marketplace. Verify with `/mcp` — a `codex`
server with 2 tools should be listed. Full tool names:

- `mcp__plugin_codex-subagent_codex__CodexAgent`
- `mcp__plugin_codex-subagent_codex__CodexStatus`

## CodexAgent parameters

| Param | Type | Notes |
|---|---|---|
| `prompt` | string, required | Self-contained task brief |
| `model` | string | See CodexStatus; omit for default |
| `effort` | enum | `low\|medium\|high\|xhigh\|max\|ultra` (`ultra` model-dependent) |
| `instructions` | string | Developer instructions; new threads only |
| `cwd` | string | Working directory; defaults to project dir |
| `sandbox` | enum | `read-only` / `workspace-write` (default) / `danger-full-access` |
| `ephemeral` | boolean | Don't persist the thread (default false) |
| `threadId` | string | Resume a prior thread from the `---codex---` footer |

Sandbox semantics: `workspace-write` lets the agent edit files under `cwd`
with network off; `read-only` blocks all writes; `danger-full-access`
disables the sandbox entirely. Approvals are hard-set to `never` — Codex
never blocks waiting for a human, and anything the sandbox would prompt for
is auto-denied.

Results are middle-truncated at ~150k chars. The MCP timeout is 30 min
(`.mcp.json`); Claude Code auto-backgrounds tool calls that run past 2 min.

Set `CODEX_EXECUTABLE` to override native-binary resolution (the npm shims
break piped stdio on Windows, so the server spawns the vendor exe directly).

## Workflow (ultracode) steps on Codex

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra', 'codex-effort: high', '',
   'Review src/ for concurrency bugs and report findings.'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
// follow-up: extract threadId from the ---codex--- footer,
// pass 'codex-thread: <id>' as a header in the next step
```

See `skills/codex-workflows/SKILL.md` for the full pattern.

## Test

```
node test/smoke.mjs            # full: handshake, tools, live Codex turn
node test/smoke.mjs --no-turn  # skip the live turn (no tokens spent)
```

## Architecture

```
Claude Code ── MCP (JSONL JSON-RPC, stdio) ── server/index.mjs
                                                │  one persistent child
                                                ▼
                                          codex app-server (JSONL JSON-RPC, stdio)
```

One `codex app-server` child is spawned lazily on first tool call and shared
across the session; threads/turns are multiplexed over it. If it crashes, the
next call respawns it and non-ephemeral threads resume via `threadId`.
