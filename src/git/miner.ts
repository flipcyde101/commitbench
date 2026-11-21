import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MineOptions, MinedTask } from "../types.js";

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|tests|test|spec|specs)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.[a-z0-9]+$/i,
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".scala",
  ".ex",
  ".exs",
  ".lua",
  ".sh",
  ".sql",
  ".vue",
  ".svelte",
]);

const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "go.sum",
]);

const SAFE_SINCE_PATTERN = /^[0-9a-zA-Z\s:.,T+\-/]+$/;

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function validateRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${resolved}`);
  }
  try {
    const inside = runGit(resolved, ["rev-parse", "--is-inside-work-tree"]).trim();
    if (inside !== "true") {
      throw new Error(`Path is not a git working tree: ${resolved}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to inspect git repository at ${resolved}: ${message}`);
  }
  return resolved;
}

function validatePositiveInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function validateSinceValue(since: string): string {
  const trimmed = since.trim();
  if (!trimmed || trimmed.startsWith("-") || !SAFE_SINCE_PATTERN.test(trimmed)) {
    throw new Error(`Invalid --since value: "${since}"`);
  }
  return trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isSourceFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (isTestFile(normalized)) {
    return false;
  }
  const base = path.posix.basename(normalized).toLowerCase();
  if (IGNORED_FILENAMES.has(base)) {
    return false;
  }
  const ext = path.posix.extname(base);
  return SOURCE_EXTENSIONS.has(ext);
}

export function redactProblemStatement(params: {
  subject: string;
  body: string;
  sourceFiles: string[];
  testFiles: string[];
  fixSha: string;
  baseSha: string;
}): string {
  const { subject, body, sourceFiles, testFiles, fixSha, baseSha } = params;

  const trailerPattern =
    /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|change-id|cherry picked from):.*$/gim;

  const combined = [subject.trim(), body.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(trailerPattern, "");

  let cleaned = combined;

  // Strip exact fix/base SHAs and their short prefixes.
  for (const sha of [fixSha, baseSha]) {
    if (sha && sha.length >= 7) {
      const shortPrefix = sha.slice(0, 7);
      const exactRegex = new RegExp(`\\b${escapeRegExp(shortPrefix)}[0-9a-f]*\\b`, "gi");
      cleaned = cleaned.replace(exactRegex, "[redacted-sha]");
    }
  }

  // Strip any generic 7-40 hex commit SHAs that contain at least one digit and one hex letter,
  // or explicit "commit <hex>" / "(<hex>)" forms.
  cleaned = cleaned.replace(
    /\bcommit\s+[0-9a-f]{7,40}\b/gi,
    "commit [redacted-sha]",
  );
  cleaned = cleaned.replace(
    /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
    "[redacted-sha]",
  );

  // Strip exact changed file paths and basenames so the agent must locate files itself.
  const spoilerTokens = new Set<string>();
  for (const file of [...sourceFiles, ...testFiles]) {
    const norm = file.replace(/\\/g, "/");
    spoilerTokens.add(norm);
    const base = path.posix.basename(norm);
    if (base.length >= 3) {
      spoilerTokens.add(base);
    }
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem.length >= 5 && (stem.includes(".") || stem.includes("_") || stem.includes("-"))) {
      spoilerTokens.add(stem);
    }
  }

  const sortedSpoilers = [...spoilerTokens].sort((a, b) => b.length - a.length);
  for (const token of sortedSpoilers) {
    const pattern = new RegExp(
      `(?<![a-zA-Z0-9_./-])${escapeRegExp(token)}(?![a-zA-Z0-9_/-]|\\.[a-zA-Z0-9_])`,
      "gi",
    );
    cleaned = cleaned.replace(pattern, "[redacted-file]");
  }

  // Clean up redundant backticks or whitespace created by redactions.
  cleaned = cleaned
    .replace(/`\[redacted-(file|sha)\]`/g, "[redacted-$1]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length < 10) {
    cleaned = "Fix the software defect reproduced by the hidden test suite without regressing existing tests.";
  }

  return [
    "Task Description:",
    cleaned,
    "",
    "Requirements:",
    "- Reproduce and fix the root cause in the repository source code.",
    "- Keep all existing tests passing.",
    "- Do not rely on external git history or hardcode answers.",
  ].join("\n");
}

export function mineTasks(options: MineOptions): MinedTask[] {
  const repoPath = validateRepoPath(options.repoPath);
  const limit = validatePositiveInt("limit", options.limit ?? 15, 1, 500);
  const maxScan = validatePositiveInt("maxScan", options.maxScan ?? Math.max(limit * 10, 150), limit, 5000);

  const logArgs = [
    "log",
    "--no-merges",
    `--max-count=${maxScan}`,
    "--format=%H%x1f%aI%x1f%s%x1f%b%x1e",
  ];

  if (options.since !== undefined) {
    logArgs.push(`--since=${validateSinceValue(options.since)}`);
  } else if (options.days !== undefined && options.days > 0) {
    const days = validatePositiveInt("days", options.days, 1, 3650);
    logArgs.push(`--since=${days} days ago`);
  }

  let rawLog = "";
  try {
    rawLog = runGit(repoPath, logArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read git log: ${message}`);
  }

  const records = rawLog
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const tasks: MinedTask[] = [];

  for (const record of records) {
    if (tasks.length >= limit) {
      break;
    }

    const parts = record.split("\x1f");
    const fixSha = (parts[0] ?? "").trim();
    const commitDate = (parts[1] ?? "").trim();
    const subject = (parts[2] ?? "").trim();
    const body = (parts[3] ?? "").trim();

    if (!/^[0-9a-f]{40}$/i.test(fixSha)) {
      continue;
    }

    let baseSha = "";
    try {
      baseSha = runGit(repoPath, ["rev-parse", "--verify", `${fixSha}~1`]).trim();
    } catch {
      // Skip root commits with no parent.
      continue;
    }

    if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
      continue;
    }

    const changedRaw = runGit(repoPath, ["diff", "--name-only", baseSha, fixSha]);
    const changedFiles = changedRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const testFiles = changedFiles.filter((file) => isTestFile(file));
    const sourceFiles = changedFiles.filter((file) => isSourceFile(file));

    if (sourceFiles.length === 0 || testFiles.length === 0) {
      continue;
    }

    const testPatch = runGit(repoPath, [
      "diff",
      "--no-color",
      "--unified=3",
      baseSha,
      fixSha,
      "--",
      ...testFiles,
    ]);

    if (testPatch.trim().length === 0) {
      continue;
    }

    const shortSha = fixSha.slice(0, 8);
    const problemStatement = redactProblemStatement({
      subject,
      body,
      sourceFiles,
      testFiles,
      fixSha,
      baseSha,
    });

    tasks.push({
      id: `task-${shortSha}`,
      repoPath,
      baseSha,
      fixSha,
      shortSha,
      commitDate,
      originalSubject: subject,
      problemStatement,
      sourceFiles,
      testFiles,
      testPatch,
      diffStats: {
        filesChanged: changedFiles.length,
        sourceFilesCount: sourceFiles.length,
        testFilesCount: testFiles.length,
        testPatchBytes: Buffer.byteLength(testPatch, "utf8"),
      },
    });
  }

  return tasks;
}

export function saveTasksFile(filePath: string, tasks: MinedTask[]): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
}

export function loadTasksFile(filePath: string): MinedTask[] {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return parsed as MinedTask[];
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "tasks" in parsed &&
    Array.isArray((parsed as { tasks: unknown }).tasks)
  ) {
    return (parsed as { tasks: MinedTask[] }).tasks;
  }
  throw new Error(`Invalid tasks JSON file format: ${resolved}`);
}
