// Resolve the native codex executable. The npm-installed `codex` command is a
// PowerShell/cmd shim on Windows that breaks piped stdio, so we spawn the
// platform binary directly, the same way @openai/codex's bin/codex.js does.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = {
  "win32-x64": { pkg: "codex-win32-x64", triples: ["x86_64-pc-windows-msvc"], exe: "codex.exe" },
  "win32-arm64": { pkg: "codex-win32-arm64", triples: ["aarch64-pc-windows-msvc"], exe: "codex.exe" },
  "darwin-x64": { pkg: "codex-darwin-x64", triples: ["x86_64-apple-darwin"], exe: "codex" },
  "darwin-arm64": { pkg: "codex-darwin-arm64", triples: ["aarch64-apple-darwin"], exe: "codex" },
  "linux-x64": {
    pkg: "codex-linux-x64",
    triples: ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"],
    exe: "codex",
  },
  "linux-arm64": {
    pkg: "codex-linux-arm64",
    triples: ["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"],
    exe: "codex",
  },
};

let cached = null;

export function locateCodex() {
  if (cached) return cached;

  const override = process.env.CODEX_EXECUTABLE;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CODEX_EXECUTABLE is set but does not exist: ${override}`);
    }
    cached = override;
    return cached;
  }

  const key = `${process.platform}-${process.arch}`;
  const info = PLATFORMS[key];
  if (!info) {
    throw new Error(`Unsupported platform for codex: ${key}. Set CODEX_EXECUTABLE to the codex binary path.`);
  }

  let npmRoot;
  try {
    npmRoot = execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim();
  } catch (err) {
    throw new Error(`Failed to run "npm root -g" while locating codex: ${err?.message ?? err}`);
  }

  const candidates = [];
  const bases = [
    join(npmRoot, "@openai", "codex", "node_modules", "@openai", info.pkg),
    join(npmRoot, "@openai", info.pkg),
  ];
  for (const base of bases) {
    for (const triple of info.triples) {
      candidates.push(join(base, "vendor", triple, "bin", info.exe));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  throw new Error(
    "codex native executable not found. Looked in:\n" +
      candidates.map((c) => `  ${c}`).join("\n") +
      "\nInstall with: npm install -g @openai/codex  (or set CODEX_EXECUTABLE)"
  );
}
