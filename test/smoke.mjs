// Smoke test for the watchdog runner. Drives skills/codex/run-codex.mjs
// directly — no Claude needed. Spends a few Codex tokens (two tiny turns).
// Usage: node test/smoke.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "skills", "codex", "run-codex.mjs");
const base = mkdtempSync(join(tmpdir(), "codex-smoke-"));

function assert(cond, label) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${label}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

function run(name, prompt, ceilingMin, extraArgs) {
  const out = join(base, name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "prompt.md"), prompt);
  const res = spawnSync(
    process.execPath,
    [
      runner, "--out", out, "--prompt-file", join(out, "prompt.md"),
      "--ceiling-min", String(ceilingMin), "--",
      "exec", ...extraArgs,
      "-s", "read-only", "-m", "gpt-5.6-luna", "-c", "model_reasoning_effort=low",
      "--skip-git-repo-check", "--ignore-user-config", "-C", root, "-",
    ],
    { encoding: "utf8", timeout: 240_000 }
  );
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  return { res, result };
}

// 1. Happy path: completes, non-empty message, threadId captured, exit 0.
const happy = run("happy", "Reply with exactly: SMOKE-OK", 5, []);
assert(happy.res.status === 0, "happy path exits 0");
assert(happy.result.ok === true, "result.ok true");
assert(happy.result.lastMessage === "SMOKE-OK", "lastMessage is SMOKE-OK");
assert(/^[0-9a-f-]{36}$/.test(happy.result.threadId), "threadId captured");
assert(happy.res.stdout.includes("RESULT: "), "RESULT line on stdout");

// 2. Resume: same thread remembers context. (resume takes no -s/-C)
const out2 = join(base, "resume");
mkdirSync(out2, { recursive: true });
writeFileSync(join(out2, "prompt.md"), "Repeat your previous reply and append: TWICE");
const res2 = spawnSync(
  process.execPath,
  [
    runner, "--out", out2, "--prompt-file", join(out2, "prompt.md"),
    "--ceiling-min", "5", "--",
    "exec", "resume", happy.result.threadId,
    "-c", 'sandbox_mode="read-only"', "-c", "model_reasoning_effort=low",
    "--skip-git-repo-check", "--ignore-user-config", "-",
  ],
  { encoding: "utf8", timeout: 240_000 }
);
const result2 = JSON.parse(readFileSync(join(out2, "result.json"), "utf8"));
assert(res2.status === 0, "resume exits 0");
assert(/SMOKE-OK/.test(result2.lastMessage), "resume remembers context");
assert(result2.threadId === happy.result.threadId, "resume keeps threadId");

// 3. Ceiling kill: tiny ceiling, expect killed + nonzero exit + result.json intact.
const killed = run("killed", "Count from 1 to 100 slowly, one line each.", 0.02, []);
assert(killed.res.status !== 0, "ceiling kill exits nonzero");
assert(killed.result.ok === false, "killed result.ok false");
assert(killed.result.killed === true, "killed flag set");
assert(/ceiling/.test(killed.result.reason), "reason mentions ceiling");

console.log("\nSMOKE PASS");
