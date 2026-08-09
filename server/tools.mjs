// Tool definitions and handlers for the codex-subagent MCP server.

import { locateCodex } from "./locate-codex.mjs";

const MAX_RESULT_CHARS = 150_000;

export const TOOLS = [
  {
    name: "CodexAgent",
    description: [
      "Launch a task on an OpenAI Codex agent (GPT models) and return its final message.",
      "",
      "The agent runs autonomously in the given working directory with full tool access",
      "(shell, file edits) inside the chosen sandbox, and returns when the turn completes.",
      "Use CodexStatus first to see available models and reasoning efforts; omit `model`",
      "for the default. Calls can take many minutes at high reasoning effort.",
      "",
      "The result ends with a `---codex---` footer containing the threadId. Pass that",
      "threadId back in a later call to continue the same conversation with full context",
      "(follow-ups, fixes, reviews of its own work). Threads persist across server",
      "restarts unless `ephemeral` was set.",
      "",
      "Sandbox levels: `read-only` (inspect only), `workspace-write` (default; edit files",
      "under cwd, no network), `danger-full-access` (no sandbox — use only when asked).",
      "",
      "Prompts should be self-contained: state the task, the relevant paths, and what the",
      "final message must contain, exactly as you would brief a subagent.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task for the Codex agent to perform. Self-contained; include paths and expected output.",
        },
        model: {
          type: "string",
          description: "Codex model id (see CodexStatus for the list, e.g. gpt-5.6-sol). Omit for the default model.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Reasoning effort. Omit for the model default. `ultra` only on models that support it.",
        },
        instructions: {
          type: "string",
          description: "Developer instructions for the agent (persona, constraints, output format). New threads only; ignored when threadId is set.",
        },
        cwd: {
          type: "string",
          description: "Absolute working directory for the agent. Defaults to the current project directory.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Filesystem sandbox policy. Default workspace-write.",
        },
        ephemeral: {
          type: "boolean",
          description: "If true, the thread is not persisted and cannot be resumed later. Default false.",
        },
        threadId: {
          type: "string",
          description: "Resume a prior Codex thread (from a previous result's ---codex--- footer) to continue that conversation.",
        },
      },
      required: ["prompt"],
    },
    annotations: {
      "anthropic/maxResultSizeChars": 200_000,
    },
  },
  {
    name: "CodexStatus",
    description:
      "Report Codex subagent health: auth status, available models with supported reasoning efforts and the default model, resolved codex executable path, and whether the app-server child is running. Call before the first CodexAgent call to pick a model, or to diagnose failures.",
    inputSchema: { type: "object", properties: {} },
  },
];

function truncateMiddle(text, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - 2 * half;
  return (
    text.slice(0, half) +
    `\n\n[... ${omitted} characters omitted (middle-truncated) ...]\n\n` +
    text.slice(text.length - half)
  );
}

function formatUsage(usage) {
  const last = usage?.last;
  if (!last) return "tokens: unknown";
  return `tokens: input=${last.inputTokens} cached=${last.cachedInputTokens} output=${last.outputTokens} reasoning=${last.reasoningOutputTokens}`;
}

async function codexAgent(codex, args, track) {
  if (!args.prompt || typeof args.prompt !== "string") {
    throw new Error("CodexAgent requires a non-empty string `prompt`");
  }
  const result = await codex.runTurn(
    {
      prompt: args.prompt,
      model: args.model,
      effort: args.effort,
      instructions: args.instructions,
      cwd: args.cwd ?? process.cwd(),
      sandbox: args.sandbox,
      ephemeral: args.ephemeral,
      threadId: args.threadId,
    },
    track
  );

  const footer = [
    "---codex---",
    `threadId: ${result.threadId}`,
    `status: ${result.status}`,
    `model: ${result.model ?? "default"}  effort: ${result.effort ?? "default"}`,
    formatUsage(result.usage),
  ].join("\n");

  const structured = {
    threadId: result.threadId,
    status: result.status,
    model: result.model,
    effort: result.effort,
    usage: result.usage?.last ?? null,
  };

  return {
    content: [{ type: "text", text: `${truncateMiddle(result.text)}\n\n${footer}` }],
    structuredContent: structured,
  };
}

async function codexStatus(codex) {
  const exePath = locateCodex();
  const [auth, models] = await Promise.all([
    codex.authStatus().catch((err) => ({ error: String(err?.message ?? err) })),
    codex.listModels().catch(() => []),
  ]);

  const visible = models.filter((m) => !m.hidden);
  const modelLines = visible.map((m) => {
    const efforts = (m.supportedReasoningEfforts ?? [])
      .map((e) => (typeof e === "string" ? e : e?.effort ?? JSON.stringify(e)))
      .join("|");
    return `- ${m.id}${m.isDefault ? " (default)" : ""}: efforts ${efforts || "n/a"} (model default: ${m.defaultReasoningEffort})`;
  });

  const text = [
    `codex executable: ${exePath}`,
    `app-server: ${codex.isAlive() ? `running (pid ${codex.child.pid})` : "not running"}`,
    `auth: ${JSON.stringify(auth)}`,
    "models:",
    ...modelLines,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      exePath,
      serverRunning: codex.isAlive(),
      pid: codex.isAlive() ? codex.child.pid : null,
      auth,
      models: visible,
    },
  };
}

export async function callTool(codex, name, args, track) {
  switch (name) {
    case "CodexAgent":
      return codexAgent(codex, args, track);
    case "CodexStatus":
      return codexStatus(codex);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
