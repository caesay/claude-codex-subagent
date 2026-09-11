// Smoke test for the watchdog runner. Drives skills/codex-agent/run-codex.mjs
// directly — no Claude needed.
// Usage: node test/smoke.mjs            (full: spends a few Codex tokens)
//        node test/smoke.mjs --offline  (contract tests only, no Codex calls)

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "skills", "codex-agent", "run-codex.mjs");
const base = mkdtempSync(join(tmpdir(), "codex-smoke-"));
const offline = process.argv.includes("--offline");

let failures = 0;
function assert(cond, label) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${label}`);
    failures++;
  } else {
    console.log(`ok: ${label}`);
  }
}

function prep(name, prompt) {
  const out = join(base, name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "prompt.md"), prompt);
  return out;
}

function invoke(out, ownArgs, codexTail, env) {
  const res = spawnSync(
    process.execPath,
    [runner, "--out", out, "--prompt-file", join(out, "prompt.md"), ...ownArgs, "--", ...codexTail],
    { encoding: "utf8", timeout: 300_000, env: env ? { ...process.env, ...env } : process.env }
  );
  const resultPath = join(out, "result.json");
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
  return { res, result };
}

const TAIL = [
  "exec", "-m", "gpt-5.6-luna", "-c", "model_reasoning_effort=low",
  "--skip-git-repo-check", "--ignore-user-config", "-C", root, "-",
];

// --- Contract tests (no Codex process) -------------------------------------

// Argument errors must still honour the result.json guarantee.
{
  const out = prep("bad-args", "unused");
  const { res, result } = invoke(out, [], ["exec", "--skip-git-repo-check"]); // missing trailing "-"
  assert(res.status === 2, "missing trailing `-` exits 2");
  assert(result !== null, "argument error still writes result.json");
  assert(result.ok === false && /must end with/.test(result.reason), "reason names the arg defect");
}

{
  const out = prep("banned-flag", "unused");
  const { res, result } = invoke(out, [], ["exec", "--json", "-"]);
  assert(res.status === 2, "caller-supplied --json is rejected");
  assert(/must not contain --json/.test(result?.reason ?? ""), "reason names the banned flag");
}

{
  const out = prep("bad-ceiling", "unused");
  const { res, result } = invoke(out, ["--ceiling-min", "NaN"], TAIL);
  assert(res.status === 2, "non-numeric --ceiling-min exits 2");
  assert(/positive number of minutes/.test(result?.reason ?? ""), "reason names the bad timer value");
}

{
  const out = prep("missing-prompt", "unused");
  const bogus = join(out, "does-not-exist.md");
  const res = spawnSync(
    process.execPath,
    [runner, "--out", out, "--prompt-file", bogus, "--", ...TAIL],
    { encoding: "utf8", timeout: 60_000 }
  );
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert(res.status === 2, "unreadable prompt file exits 2");
  assert(/cannot read --prompt-file/.test(result.reason), "reason names the prompt file");
}

// A stale final message from an earlier run must not be counted as success.
{
  const out = prep("stale", "unused");
  writeFileSync(join(out, "last-message.txt"), "STALE ANSWER FROM A PREVIOUS RUN");
  const { result } = invoke(out, [], ["exec", "--skip-git-repo-check"]); // fails arg validation
  assert(result.lastMessage === null, "stale last-message.txt is cleared, not reported");
  assert(result.ok === false, "stale message cannot make a failed run look ok");
}

// stdout must never carry the payload — the supervising agent reads it once,
// from last-message.txt, not once per copy.
{
  const out = prep("quiet-stdout", "unused");
  const { res } = invoke(out, [], ["exec", "--skip-git-repo-check"]); // fails arg validation
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT: "));
  assert(Boolean(line), "RESULT line on stdout even for an argument error");
  const summary = JSON.parse(line.slice("RESULT: ".length));
  assert(!("lastMessage" in summary), "stdout RESULT carries no lastMessage");
  assert(summary.lastMessageChars === 0, "lastMessageChars reported");
  assert(typeof summary.lastMessageFile === "string", "lastMessageFile pointer reported");
  assert(typeof summary.resultFile === "string", "resultFile pointer reported");
  assert("threadId" in summary && "durationMs" in summary, "stdout keeps the non-payload fields");
}

// The prompt Codex receives is composed by the runner, not the caller: the
// scratch directory and the absence of a sandbox must be stated without anyone
// having to remember to state them. Stopping at locateCodex keeps this offline.
{
  const NO_CODEX = { CODEX_EXECUTABLE: join(base, "there-is-no-codex-here") };
  const noSandboxTail = ["exec", "-m", "gpt-5.6-luna", "--skip-git-repo-check", "-"];

  const out = prep("preamble", "THE ACTUAL TASK");
  const { res } = invoke(out, [], noSandboxTail, NO_CODEX);
  assert(res.status === 2, "missing codex executable exits 2");
  const sent = readFileSync(join(out, "prompt-sent.md"), "utf8");
  assert(sent.includes("<runtime>"), "prompt-sent.md carries the runtime preamble");
  assert(sent.includes("Sandbox: disabled"), "preamble states the sandbox is off");
  assert(sent.includes(join(out, "scratch")), "preamble names the scratch directory");
  assert(existsSync(join(out, "scratch")), "scratch directory created before the run");
  assert(sent.trimEnd().endsWith("THE ACTUAL TASK"), "caller prompt follows the preamble verbatim");

  // A caller that supplies a sandbox does not get one. Passing it through
  // alongside the bypass flag is what makes codex reject the invocation.
  const out2 = prep("preamble-sandboxed", "THE ACTUAL TASK");
  const { res: res2 } = invoke(
    out2,
    [],
    ["exec", "-s", "read-only", "-c", "sandbox_mode=read-only", "--approve-for-me", "--skip-git-repo-check", "-"],
    NO_CODEX
  );
  const sent2 = readFileSync(join(out2, "prompt-sent.md"), "utf8");
  assert(sent2.includes("Sandbox: disabled"), "caller-supplied sandbox cannot re-enable one");
  assert(/dropped: .*-s read-only/.test(res2.stderr), "dropped sandbox args are named on stderr");
  assert(/sandbox_mode=read-only/.test(res2.stderr), "config-form sandbox is dropped too");
  assert(/--approve-for-me/.test(res2.stderr), "approval routing is dropped too");

  // --scratch overrides the default location.
  const out3 = prep("preamble-scratch", "THE ACTUAL TASK");
  const custom = join(base, "my-scratch");
  invoke(out3, ["--scratch", custom], noSandboxTail, NO_CODEX);
  assert(existsSync(custom), "--scratch directory created");
  assert(
    readFileSync(join(out3, "prompt-sent.md"), "utf8").includes(custom),
    "--scratch location is the one advertised"
  );
}

if (offline) {
  console.log(failures ? `\nSMOKE FAIL (${failures})` : "\nSMOKE PASS (offline subset)");
  process.exit(failures ? 1 : 0);
}

// --- Live tests (real Codex turns) -----------------------------------------

// 1. Happy path: completes, non-empty message, threadId captured, exit 0.
const happyOut = prep("happy", "Reply with exactly: SMOKE-OK");
const happy = invoke(happyOut, ["--ceiling-min", "5"], TAIL);
assert(happy.res.status === 0, "happy path exits 0");
assert(happy.result.ok === true, "result.ok true");
assert(happy.result.lastMessage === "SMOKE-OK", "lastMessage is SMOKE-OK");
assert(/^[0-9a-f-]{36}$/.test(happy.result.threadId ?? ""), "threadId captured");
assert(happy.res.stdout.includes("RESULT: "), "RESULT line on stdout");
assert(existsSync(join(happyOut, "events.jsonl")), "events.jsonl written");

// 2. Resume: same thread remembers context. (resume takes no -C)
const resumeOut = prep("resume", "Repeat your previous reply and append: TWICE");
const resume = invoke(resumeOut, ["--ceiling-min", "5"], [
  "exec", "resume", happy.result.threadId,
  "-c", "model_reasoning_effort=low",
  "--skip-git-repo-check", "--ignore-user-config", "-",
]);
assert(resume.res.status === 0, "resume exits 0");
assert(/SMOKE-OK/.test(resume.result.lastMessage ?? ""), "resume remembers context");
assert(resume.result.threadId === happy.result.threadId, "resume keeps threadId");

// 3. Ceiling kill: tiny ceiling, expect killed + nonzero exit + result.json intact.
const killedOut = prep("killed", "Count from 1 to 100 slowly, one line each.");
const killed = invoke(killedOut, ["--ceiling-min", "0.02"], TAIL);
assert(killed.res.status !== 0, "ceiling kill exits nonzero");
assert(killed.result.ok === false, "killed result.ok false");
assert(killed.result.killed === true, "killed flag set");
assert(/ceiling/.test(killed.result.reason ?? ""), "reason mentions ceiling");
assert(killed.result.threadId !== null, "threadId preserved for resume after kill");

console.log(failures ? `\nSMOKE FAIL (${failures})` : "\nSMOKE PASS");
process.exit(failures ? 1 : 0);
