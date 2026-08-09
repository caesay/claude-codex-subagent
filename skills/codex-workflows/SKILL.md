---
name: codex-workflows
description: How to run tasks on OpenAI Codex (GPT models) from this session —
  direct CodexAgent tool calls, multi-turn threads, and assigning Workflow
  (ultracode) steps to Codex models via the codex-runner relay agent.
---

# Running Codex subagents

Two ways to run a task on an OpenAI Codex model (GPT) from Claude Code.

## 1. Direct tool call

Call `mcp__plugin_codex-subagent_codex__CodexAgent` (load via ToolSearch if
absent). Call `CodexStatus` first to see available models and efforts.

```
CodexAgent {
  prompt: "Review src/ for concurrency bugs and report findings with file:line.",
  model: "gpt-5.6-terra",     // omit for default
  effort: "high",             // low|medium|high|xhigh|max|ultra
  sandbox: "read-only",       // read-only | workspace-write (default) | danger-full-access
  cwd: "C:\\path\\to\\project"
}
```

The result ends with a `---codex---` footer:

```
---codex---
threadId: 019876ab-...
status: completed
model: gpt-5.6-terra  effort: high
tokens: input=12345 cached=800 output=2100 reasoning=1400
```

To continue the conversation (follow-ups, "now fix what you found"), pass the
footer's `threadId` back:

```
CodexAgent { prompt: "Fix finding #2.", threadId: "019876ab-..." }
```

Long calls at high effort can run many minutes; the MCP timeout is 30 min and
Claude Code auto-backgrounds calls that exceed 2 min.

## 2. Workflow step on a Codex model

Workflow `agent()` steps cannot run GPT models directly — subagent `model:`
frontmatter is Claude-only. Instead assign the step to the `codex-runner`
relay agent (a thin Sonnet agent that makes one CodexAgent call and returns
the result verbatim). Pass Codex parameters as leading header lines:

```js
const result = await agent(
  ['codex-model: gpt-5.6-terra',
   'codex-effort: high',
   '',
   'Review src/ for concurrency bugs and report findings with file:line.'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
```

Supported headers: `codex-model:`, `codex-effort:`, `codex-thread:`,
`codex-sandbox:`, `codex-cwd:`. Everything after the first blank line is the
prompt.

Follow-up steps continue the same Codex thread by extracting the threadId from
the `---codex---` footer of the previous result:

```js
const threadId = /threadId: (\S+)/.exec(result)[1]
const fixed = await agent(
  [`codex-thread: ${threadId}`, '', 'Now fix every finding you reported.'].join('\n'),
  { agentType: 'codex-subagent:codex-runner' })
```

A relay result starting with `CODEX-ERROR:` means the CodexAgent call itself
failed (auth, model name, crash) — not task output.
