/**
 * Check whether upstream has new commits and write a hand-off prompt for an AI.
 *
 * Runs on folder open through .vscode/tasks.json (open the folder or the
 * .code-workspace file in VS Code and allow automatic tasks once), or by hand:
 *     npm run check:upstream
 * Writes UPSTREAM-UPDATE.md (gitignored) when there is something to merge.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORT = join(ROOT, "UPSTREAM-UPDATE.md");

// Upstream files this fork edited. Additive lines only, but a conflict can still land here.
const FORK_TOUCHED = [".gitignore", "README.md", "package.json", "src/index.ts"];

const PROMPT = `Merge the latest upstream into this fork without losing our additions.

Context: this repo is a private fork of MadLlama25/fastmail-mcp.
Our additions are listed in README.md ("About this fork") and CLAUDE.local.md.
Upstream files only carry additive lines.

Steps:
1. git fetch upstream && git merge upstream/main
2. If a file conflicts, keep upstream's structure and re-attach our lines
   (the list of touched files is below).
3. npm ci
4. npm run build && npm test && npm run scan:secrets
5. Read the upstream commits below. If one adds a feature we also ported,
   prefer upstream's version and delete ours.
6. Commit and push.
`;

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

try {
  git("fetch", "upstream", "--quiet");
} catch (err) {
  console.log(`Could not fetch upstream: ${String(err.stderr ?? err).trim()}`);
  process.exit(1);
}

const base = process.argv[2] ?? "main"; // override for testing
const log = git("log", "--oneline", `${base}..upstream/main`);

if (!log) {
  console.log("Upstream: up to date.");
  if (existsSync(REPORT)) rmSync(REPORT);
  process.exit(0);
}

const commits = log.split("\n");
const changed = git("diff", "--name-only", `${base}...upstream/main`).split("\n");
const overlap = changed.filter((f) => FORK_TOUCHED.includes(f));
const tags = git("tag", "--points-at", "upstream/main");

const lines = [
  `# Upstream has ${commits.length} new commit(s)${tags ? ` (${tags})` : ""}`,
  "",
  "Paste the block below into the AI chat.",
  "",
  "```",
  PROMPT.trimEnd(),
  "",
  "Upstream files we also edited (watch these for conflicts):",
  ...(overlap.length ? overlap : ["none"]).map((f) => `- ${f}`),
  "",
  "New upstream commits:",
  ...commits.map((c) => `- ${c}`),
  "```",
  "",
];
writeFileSync(REPORT, lines.join("\n"), "utf8");

console.log(
  `Upstream: ${commits.length} new commit(s). Hand-off written to UPSTREAM-UPDATE.md`,
);
// Pop the hand-off into the editor so the update is hard to miss.
try {
  const code = process.platform === "win32" ? "code.cmd" : "code";
  execFileSync(code, ["-r", REPORT], { stdio: "ignore" });
} catch {
  // VS Code not on PATH; the console output below is enough.
}
console.log("Files we also edited:", overlap.join(", ") || "none");
for (const c of commits.slice(0, 15)) console.log(" ", c);
if (commits.length > 15) console.log(`  ... and ${commits.length - 15} more`);
