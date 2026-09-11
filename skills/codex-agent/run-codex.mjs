#!/usr/bin/env node
// Watchdog runner for one `codex exec` call. No daemon, dies with the call.
//
// Usage:
//   node run-codex.mjs --out <dir> --prompt-file <file> [--ceiling-min 30] [--stall-min 10] [--scratch <dir>] -- <codex exec args...>
//
// The runner owns all output paths under --out:
//   events.jsonl      JSONL event stream (--json)
//   stderr.txt        codex stderr
//   last-message.txt  final agent message (-o)
//   prompt-sent.md    the prompt as codex received it, preamble included
//   scratch/          working space offered to codex (override with --scratch)
//   result.json       {ok, exitCode, killed, reason, threadId, durationMs, lastMessage}
//
// stdout carries one `RESULT: {...}` line with those fields EXCEPT lastMessage,
// plus lastMessageChars/lastMessageFile/resultFile pointers. The final message
// is deliberately kept off stdout so a supervising agent reads it exactly once,
// from last-message.txt, instead of once per copy.
//
// The prompt is delivered via stdin (codex arg `-`), so arbitrary content needs
// no shell quoting. The codex args after `--` must NOT include --json, -o, or a
// prompt — the runner appends those. Example arg tails:
//   exec -s read-only -m gpt-5.6-luna -c model_reasoning_effort=low --skip-git-repo-check -C <cwd> -
//   exec resume <threadId> -c sandbox_mode="read-only" -
//
// Codex always runs unsandboxed: the runner appends
// --dangerously-bypass-approvals-and-sandbox, and strips any sandbox or
// approval argument the caller supplied. There is no override. The prompt is
// prefixed with a <runtime> block naming the scratch directory and the absence
// of a sandbox.
//
// Guarantees (the reasons this script exists):
//   - Wall-clock ceiling: the codex process tree is killed after --ceiling-min.
//   - Stall detection: killed after --stall-min with no stdout/stderr output.
//   - Signals (SIGINT/SIGTERM/SIGHUP/SIGBREAK) kill the codex tree and still
//     write result.json, so cancelling the runner cannot orphan codex.
//   - result.json is ALWAYS written once --out is known — including argument
//     errors, spawn failures, stream errors, and signals.
//   - Exit 0 only when codex exited 0 AND this run wrote a non-empty final
//     message (a stale message from a previous run in the same --out cannot
//     count: the file is removed before spawning).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { locateCodex } from "./locate-codex.mjs";

const MAX_TIMER_MS = 2_147_483_647;
const STREAM_FLUSH_GRACE_MS = 5_000;
const POST_EXIT_CLOSE_GRACE_MS = 3_000;

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep < 0 ? argv : argv.slice(0, sep);
const codexArgs = sep < 0 ? [] : argv.slice(sep + 1);

function ownFlag(name, fallback) {
  const i = own.indexOf(name);
  return i >= 0 ? own[i + 1] : fallback;
}

const outDir = ownFlag("--out");
const startedAt = Date.now();

const state = {
  ok: false,
  exitCode: null,
  killed: false,
  reason: null,
  threadId: null,
  durationMs: 0,
  lastMessage: null,
};

let paths = null;
if (outDir) {
  try {
    mkdirSync(outDir, { recursive: true });
    paths = {
      events: join(outDir, "events.jsonl"),
      stderr: join(outDir, "stderr.txt"),
      lastMessage: join(outDir, "last-message.txt"),
      result: join(outDir, "result.json"),
      promptSent: join(outDir, "prompt-sent.md"),
    };
  } catch (err) {
    process.stderr.write(`run-codex: cannot create --out dir: ${err?.message ?? err}\n`);
  }
}

let resultWritten = false;
let spawnedRun = false; // only a run that actually started can own a final message
function writeResult() {
  if (resultWritten) return;
  resultWritten = true;
  state.durationMs = Date.now() - startedAt;
  if (paths && spawnedRun) {
    try {
      state.lastMessage = existsSync(paths.lastMessage)
        ? readFileSync(paths.lastMessage, "utf8").trim() || null
        : null;
    } catch (err) {
      state.reason ??= `cannot read final message file: ${err?.message ?? err}`;
    }
  }
  state.ok = state.exitCode === 0 && !state.killed && Boolean(state.lastMessage);
  if (state.ok) {
    // A benign advisory (e.g. codex closed stdin early) must not be reported as
    // a failure once the run demonstrably produced a real answer.
    state.reason = null;
  } else if (!state.reason) {
    state.reason = "codex exited 0 but produced no final message";
  }
  const json = JSON.stringify(state, null, 2);
  if (paths) {
    try {
      writeFileSync(paths.result, json);
    } catch (err) {
      process.stderr.write(`run-codex: cannot write result.json: ${err?.message ?? err}\n`);
    }
  }
  // stdout is read by a supervising agent, so it must never carry the payload:
  // the final message would otherwise land in that context here, again in
  // result.json, and a third time in the agent's own report. Only the pointer
  // goes out; the text is read once, from last-message.txt.
  const { lastMessage, ...summary } = state;
  summary.lastMessageChars = lastMessage ? lastMessage.length : 0;
  summary.lastMessageFile = paths ? paths.lastMessage : null;
  summary.resultFile = paths ? paths.result : null;
  process.stdout.write(`RESULT: ${JSON.stringify(summary)}\n`);
}

// Argument/setup failure: still honour the result.json contract when possible.
function fatal(msg) {
  state.reason = msg;
  state.exitCode = state.exitCode ?? null;
  process.stderr.write(`run-codex: ${msg}\n`);
  writeResult();
  process.exit(2);
}

if (!outDir) fatal("--out is required");
if (!paths) fatal("--out directory could not be created");
if (sep < 0) fatal("missing `--` separator before codex args");

function positiveMinutes(flag, fallback) {
  const raw = ownFlag(flag, fallback);
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fatal(`${flag} must be a positive number of minutes (got ${JSON.stringify(raw)})`);
  }
  const ms = minutes * 60_000;
  if (ms > MAX_TIMER_MS) fatal(`${flag} exceeds the maximum supported timer (~35791 min)`);
  return ms;
}

const ceilingMs = positiveMinutes("--ceiling-min", "30");
const stallMs = positiveMinutes("--stall-min", "10");

const promptFile = ownFlag("--prompt-file");
if (!promptFile) fatal("--prompt-file is required");

// Read the prompt BEFORE spawning: an unreadable prompt must never leave a
// started codex process behind.
let promptBuf;
try {
  promptBuf = readFileSync(promptFile);
} catch (err) {
  fatal(`cannot read --prompt-file: ${err?.message ?? err}`);
}

if (codexArgs[0] !== "exec") fatal("codex args must start with `exec`");
if (codexArgs[codexArgs.length - 1] !== "-") fatal("codex args must end with `-` (prompt via stdin)");
for (const banned of ["--json", "-o", "--output-last-message"]) {
  if (codexArgs.includes(banned)) {
    fatal(`codex args must not contain ${banned} — the runner supplies it`);
  }
}

// Codex always runs unsandboxed here. There is no override, by design.
//
// A sandbox denial does not arrive as a clear "not allowed" — it surfaces
// mid-run as a failed command that the agent then tries to work around, burning
// turns and ending in a partial answer. Approval prompts are worse: nothing is
// there to answer them, so the run sits until the stall timer kills it. And a
// caller that passes its own sandbox flag alongside the bypass makes codex
// reject the invocation outright, which is how this surfaced in practice:
// callers kept supplying one.
//
// So sandbox arguments are stripped from the caller's args rather than honoured
// or rejected. Stripping keeps the run working; rejecting would only move the
// failure. The exception is a caller-supplied bypass flag, which is dropped
// here only to avoid passing it twice.
const BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const SANDBOX_VALUE_FLAGS = new Set(["-s", "--sandbox"]);
const stripped = [];
const cleanedArgs = [];
// The trailing `-` is validated above and re-appended below; excluding it here
// stops a value-taking flag from swallowing it.
const headArgs = codexArgs.slice(0, -1);
for (let i = 0; i < headArgs.length; i++) {
  const arg = headArgs[i];
  if (SANDBOX_VALUE_FLAGS.has(arg)) {
    stripped.push(`${arg} ${headArgs[i + 1] ?? ""}`.trim());
    i++; // its value
    continue;
  }
  if (arg.startsWith("--sandbox=") || arg === BYPASS || arg === "--approve-for-me") {
    stripped.push(arg);
    continue;
  }
  // `-c sandbox_mode=...` and `-c approval_policy=...` arrive as two args.
  if (arg === "-c" || arg === "--config") {
    const next = headArgs[i + 1] ?? "";
    if (next.startsWith("sandbox_mode=") || next.startsWith("approval_policy=")) {
      stripped.push(`${arg} ${next}`);
      i++;
      continue;
    }
  }
  cleanedArgs.push(arg);
}
if (stripped.length) {
  process.stderr.write(
    `run-codex: sandbox arguments are not supported and were dropped: ${stripped.join(" ")}\n`
  );
}
const sandboxArgs = [BYPASS];

// Named in the prompt preamble below, and created here, so that no caller has
// to remember to offer one. Without a stated scratch location Codex writes test
// harnesses, throwaway clones and build output into the tree it was asked to
// reason about.
const scratchDir = ownFlag("--scratch", join(outDir, "scratch"));
try {
  mkdirSync(scratchDir, { recursive: true });
} catch (err) {
  fatal(`cannot create scratch directory: ${err?.message ?? err}`);
}

// Prepended to every prompt so the two facts Codex most often has to discover
// the hard way — that nothing is blocked, and where to put mess — are stated up
// front. Written to prompt-sent.md as well, so "what did Codex actually see" is
// answerable after the fact.
const preamble = [
  "<runtime>",
  "Sandbox: disabled. You have full filesystem and network access and no",
  "command requires approval. Nothing will be blocked, so do not design around",
  "restrictions that are not there, and do not stop to ask for permission. The",
  "corollary: the task below is the only thing scoping what you should touch.",
  "Stay inside it.",
  "",
  `Scratch directory: ${scratchDir}`,
  "It exists already. Put throwaway artifacts there — temporary files, test",
  "harnesses, fresh clones, build output, downloaded data — rather than in the",
  "working tree you were asked to reason about or the system temp directory.",
  "</runtime>",
  "",
  "Everything below this line is the task.",
  "",
  "",
].join("\n");
const sentBuf = Buffer.concat([Buffer.from(preamble, "utf8"), promptBuf]);
try {
  writeFileSync(paths.promptSent, sentBuf);
} catch (err) {
  fatal(`cannot write prompt-sent.md: ${err?.message ?? err}`);
}

// A stale final message from a previous run in this directory must not be able
// to make a failed run look successful.
try {
  rmSync(paths.lastMessage, { force: true });
} catch (err) {
  fatal(`cannot clear previous final message file: ${err?.message ?? err}`);
}

let exe;
try {
  exe = locateCodex();
} catch (err) {
  fatal(String(err?.message ?? err));
}

const fullArgs = [...cleanedArgs, ...sandboxArgs, "--json", "-o", paths.lastMessage, "-"];

// POSIX: detached gives the child its own process group so the whole tree can
// be signalled via -pid. Not unref'd, so exit events still arrive. On Windows
// detached would spawn a console window; taskkill /T handles the tree there.
const isWin = process.platform === "win32";
const child = spawn(exe, fullArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  detached: !isWin,
});
spawnedRun = true;

const eventsOut = createWriteStream(paths.events);
const stderrOut = createWriteStream(paths.stderr);
for (const [name, stream] of [["events.jsonl", eventsOut], ["stderr.txt", stderrOut]]) {
  stream.on("error", (err) => {
    state.reason ??= `cannot write ${name}: ${err?.message ?? err}`;
    treeKill(state.reason);
  });
}

child.stdin.on("error", (err) => {
  // EPIPE here means codex died before consuming the prompt; the exit handler
  // reports the real cause, so only record it if nothing better is known.
  state.reason ??= `failed to send prompt to codex: ${err?.message ?? err}`;
});
child.stdin.end(sentBuf);

let lastActivity = Date.now();
let lineBuf = "";
child.stdout.on("data", (d) => {
  lastActivity = Date.now();
  eventsOut.write(d);
  if (state.threadId) return;
  lineBuf += d.toString();
  let i;
  while ((i = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, i);
    lineBuf = lineBuf.slice(i + 1);
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started" && e.thread_id) state.threadId = e.thread_id;
    } catch {}
  }
});
child.stderr.on("data", (d) => {
  lastActivity = Date.now();
  stderrOut.write(d);
});

function treeKill(reason) {
  if (state.killed || child.exitCode !== null) return;
  state.killed = true;
  state.reason ??= reason;
  if (isWin) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", (err) => {
      state.reason += ` (taskkill failed to start: ${err?.message ?? err}; codex tree may survive)`;
      try { child.kill("SIGKILL"); } catch {}
    });
    killer.on("exit", (code) => {
      // 128 = "process not found", i.e. it already exited; anything else is a
      // real failure the caller must know about.
      if (code !== 0 && code !== 128) {
        state.reason += ` (taskkill exited ${code}; codex tree may survive)`;
      }
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // whole process group
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}

const ceilingTimer = setTimeout(
  () => treeKill(`wall-clock ceiling exceeded (${ceilingMs / 60000} min)`),
  ceilingMs
);
const stallTimer = setInterval(() => {
  if (Date.now() - lastActivity > stallMs) {
    treeKill(`no output for ${stallMs / 60000} min (stalled)`);
  }
}, Math.min(30_000, Math.max(1_000, Math.floor(stallMs / 4))));

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(sig, () => {
      treeKill(`runner received ${sig}; codex tree killed`);
      // Give the kill a beat to land, then finalize regardless.
      setTimeout(() => finalize(), 500).unref?.();
    });
  } catch {}
}

let finalizing = false;
function finalize() {
  if (finalizing) return;
  finalizing = true;
  clearTimeout(ceilingTimer);
  clearInterval(stallTimer);

  // Flush both log streams before exiting; a slow filesystem must not truncate
  // events.jsonl or stderr.txt.
  const flush = (stream) =>
    new Promise((resolve) => {
      if (stream.destroyed || stream.writableEnded) return resolve();
      stream.end(resolve);
      stream.on("error", resolve);
    });
  const guard = new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_GRACE_MS).unref?.());

  Promise.race([Promise.all([flush(eventsOut), flush(stderrOut)]), guard]).then(() => {
    writeResult();
    process.exit(state.ok ? 0 : 1);
  });
}

child.on("error", (err) => {
  state.reason ??= `spawn failed: ${err?.message ?? err}`;
  finalize();
});

child.on("exit", (code, signal) => {
  state.exitCode = code;
  if (!state.reason && code !== 0) state.reason = `codex exited ${signal ?? code}`;
  // Prefer `close` (all stdio drained); fall back if it never arrives.
  setTimeout(finalize, POST_EXIT_CLOSE_GRACE_MS).unref?.();
});

child.on("close", () => finalize());
