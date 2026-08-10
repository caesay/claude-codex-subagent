#!/usr/bin/env node
// Watchdog runner for one `codex exec` call. No daemon, dies with the call.
//
// Usage:
//   node run-codex.mjs --out <dir> --prompt-file <file> [--ceiling-min 30] [--stall-min 10] -- <codex exec args...>
//
// The runner owns all output paths under --out:
//   events.jsonl   JSONL event stream (--json)
//   stderr.txt     codex stderr
//   last-message.txt  final agent message (-o)
//   result.json    {ok, exitCode, killed, reason, threadId, durationMs, lastMessage}
//
// The prompt is delivered via stdin (codex arg `-`), so arbitrary content needs
// no shell quoting. The codex args after `--` must NOT include --json, -o, or a
// prompt — the runner appends those. Example arg tails:
//   exec -s read-only -m gpt-5.6-luna -c model_reasoning_effort=low --skip-git-repo-check -C <cwd> -
//   exec resume <threadId> -c sandbox_mode="read-only" -
//
// Guarantees (the reasons this script exists):
//   - Wall-clock ceiling: the codex process is tree-killed after --ceiling-min.
//   - Stall detection: tree-killed after --stall-min with no stdout/stderr output.
//   - result.json is ALWAYS written, even on spawn failure.
//   - Exit 0 only when codex exited 0 AND the final message is non-empty.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { locateCodex } from "./locate-codex.mjs";

function fail(msg) {
  process.stderr.write(`run-codex: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) fail("missing `--` separator before codex args");
const own = argv.slice(0, sep);
const codexArgs = argv.slice(sep + 1);

function ownFlag(name, fallback) {
  const i = own.indexOf(name);
  return i >= 0 ? own[i + 1] : fallback;
}

const outDir = ownFlag("--out");
const promptFile = ownFlag("--prompt-file");
const ceilingMs = Number(ownFlag("--ceiling-min", "30")) * 60_000;
const stallMs = Number(ownFlag("--stall-min", "10")) * 60_000;
if (!outDir) fail("--out is required");
if (!promptFile || !existsSync(promptFile)) fail("--prompt-file is required and must exist");
if (codexArgs[0] !== "exec") fail("codex args must start with `exec`");
if (codexArgs[codexArgs.length - 1] !== "-") fail("codex args must end with `-` (prompt via stdin)");

mkdirSync(outDir, { recursive: true });
const paths = {
  events: join(outDir, "events.jsonl"),
  stderr: join(outDir, "stderr.txt"),
  lastMessage: join(outDir, "last-message.txt"),
  result: join(outDir, "result.json"),
};

const state = {
  ok: false,
  exitCode: null,
  killed: false,
  reason: null,
  threadId: null,
  durationMs: 0,
  lastMessage: null,
};
const startedAt = Date.now();

function writeResult() {
  state.durationMs = Date.now() - startedAt;
  try {
    state.lastMessage = existsSync(paths.lastMessage)
      ? readFileSync(paths.lastMessage, "utf8").trim()
      : null;
  } catch {}
  state.ok = state.exitCode === 0 && !state.killed && Boolean(state.lastMessage);
  if (state.exitCode === 0 && !state.killed && !state.lastMessage) {
    state.reason = "codex exited 0 but produced no final message";
  }
  writeFileSync(paths.result, JSON.stringify(state, null, 2));
  process.stdout.write(`RESULT: ${JSON.stringify(state)}\n`);
}

let exe;
try {
  exe = locateCodex();
} catch (err) {
  state.reason = String(err?.message ?? err);
  writeResult();
  process.exit(2);
}

// Insert --json and -o right after the subcommand chain, before the `-` prompt.
const fullArgs = [...codexArgs.slice(0, -1), "--json", "-o", paths.lastMessage, "-"];

const child = spawn(exe, fullArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stdin.write(readFileSync(promptFile));
child.stdin.end();

const eventsOut = createWriteStream(paths.events);
const stderrOut = createWriteStream(paths.stderr);

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
  state.reason = reason;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { child.kill("SIGKILL"); } catch {}
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
}, 30_000);

child.on("error", (err) => {
  clearTimeout(ceilingTimer);
  clearInterval(stallTimer);
  state.reason = `spawn failed: ${err?.message ?? err}`;
  writeResult();
  process.exit(2);
});

child.on("exit", (code, signal) => {
  clearTimeout(ceilingTimer);
  clearInterval(stallTimer);
  state.exitCode = code;
  if (!state.reason && code !== 0) state.reason = `codex exited ${signal ?? code}`;
  // Give the -o file write a moment to flush on some platforms.
  setTimeout(() => {
    eventsOut.end();
    stderrOut.end();
    writeResult();
    process.exit(state.ok ? 0 : 1);
  }, 200);
});
