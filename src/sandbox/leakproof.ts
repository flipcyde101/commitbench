import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestFile } from "../git/miner.js";
import type { LeakCheckResult } from "../types.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

const STRIPPED_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
] as const;

export interface LeakProofWorkspace {
  dir: string;
  initialCommitSha: string;
  cleanup: () => void;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export function buildSanitizedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...(extra ?? {}) };
  for (const key of STRIPPED_GIT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function assertValidSha(label: string, sha: string): string {
  const trimmed = sha.trim();
  if (!SHA_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${label} SHA: "${sha}"`);
  }
  return trimmed;
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const zeroIdx = slice.indexOf(0);
  const raw = zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx);
  return raw.toString("utf8");
}

function readTarOctal(buf: Buffer, offset: number, length: number): number {
  const raw = readTarString(buf, offset, length).trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let cursor = 0;
  while (cursor < data.length) {
    const spaceIdx = data.indexOf(0x20, cursor);
    if (spaceIdx === -1) {
      break;
    }
    const lenStr = data.subarray(cursor, spaceIdx).toString("ascii");
    if (!/^\d+$/.test(lenStr)) {
      break;
    }
    const recordLen = Number.parseInt(lenStr, 10);
    const minLen = spaceIdx - cursor + 2;
    const entryEnd = cursor + recordLen;
    if (!Number.isFinite(recordLen) || recordLen < minLen || entryEnd > data.length) {
      break;
    }
    const bodyEnd = data[entryEnd - 1] === 0x0a ? entryEnd - 1 : entryEnd;
    const body = data.subarray(spaceIdx + 1, bodyEnd).toString("utf8");
    const eqIdx = body.indexOf("=");
    if (eqIdx !== -1) {
      const key = body.slice(0, eqIdx);
      const value = body.slice(eqIdx + 1);
      records[key] = value;
    }
    cursor = entryEnd;
  }
  return records;
}

function isWithinRoot(rootReal: string, candidate: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(rootReal);
  const c = norm(candidate);
  return c === r || c.startsWith(r + path.sep);
}

function resolveSafeTarget(destDir: string, entryName: string): string {
  if (entryName.includes("\0")) {
    throw new Error(`Unsafe archive entry path rejected: "${entryName}"`);
  }
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe archive entry path rejected: "${entryName}"`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw new Error(`Unsafe archive entry path rejected: "${entryName}"`);
  }
  const root = path.resolve(destDir);
  const target = path.resolve(root, normalized);
  if (!isWithinRoot(root, target)) {
    throw new Error(`Unsafe archive entry path rejected: "${entryName}"`);
  }
  return target;
}

function assertParentRealpathWithinRoot(rootReal: string, targetPath: string): void {
  const parentDir = path.dirname(targetPath);
  fs.mkdirSync(parentDir, { recursive: true });
  const parentReal = fs.realpathSync.native(parentDir);
  if (!isWithinRoot(rootReal, parentReal)) {
    throw new Error(`Unsafe archive write escaping destination root: "${targetPath}"`);
  }
}

export function extractTarBuffer(tarBuffer: Buffer, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const rootReal = fs.realpathSync.native(path.resolve(destDir));
  let offset = 0;
  let pendingPax: Record<string, string> = {};
  const deferredWindowsSymlinks: Array<{ targetPath: string; resolvedLink: string }> = [];

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end-of-archive.
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      break;
    }

    const nameField = readTarString(header, 0, 100);
    const mode = readTarOctal(header, 100, 8);
    const headerSize = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const linkNameField = readTarString(header, 157, 100);
    const prefixField = readTarString(header, 345, 155);

    const paxSize =
      pendingPax.size && /^\d+$/.test(pendingPax.size)
        ? Number.parseInt(pendingPax.size, 10)
        : undefined;
    const size = paxSize !== undefined && Number.isSafeInteger(paxSize) ? paxSize : headerSize;

    offset += 512;
    const dataEnd = offset + size;
    if (size < 0 || dataEnd > tarBuffer.length) {
      throw new Error("Truncated or corrupt tar archive entry.");
    }
    const data = tarBuffer.subarray(offset, dataEnd);
    const paddedBlocks = Math.ceil(size / 512) * 512;
    offset += paddedBlocks;

    // Ignore global PAX header (git archive embeds commit SHA comments here).
    if (typeFlag === "g") {
      continue;
    }

    // Per-file PAX extended header (used for long paths > 100 chars or UTF-8 names).
    if (typeFlag === "x") {
      pendingPax = { ...pendingPax, ...parsePaxRecords(data) };
      continue;
    }

    const fullName =
      pendingPax.path ??
      (prefixField ? `${prefixField}/${nameField}` : nameField);
    const linkTarget = pendingPax.linkpath ?? linkNameField;
    pendingPax = {};

    if (!fullName || fullName === "." || fullName === "./") {
      continue;
    }

    const targetPath = resolveSafeTarget(destDir, fullName);

    if (typeFlag === "5" || fullName.endsWith("/")) {
      assertParentRealpathWithinRoot(rootReal, targetPath);
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (typeFlag === "1") {
      throw new Error(`Unsupported hardlink entry rejected in archive: "${fullName}"`);
    }

    if (typeFlag === "2") {
      if (linkTarget.includes("\0") || path.isAbsolute(linkTarget)) {
        throw new Error(`Unsafe symlink target rejected: "${linkTarget}"`);
      }
      assertParentRealpathWithinRoot(rootReal, targetPath);
      const parentReal = fs.realpathSync.native(path.dirname(targetPath));
      const resolvedLink = path.resolve(parentReal, linkTarget);
      const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
      // Reject symlinks escaping root OR pointing to root itself (which enables symlink-chain escapes).
      if (norm(resolvedLink) === norm(rootReal) || !isWithinRoot(rootReal, resolvedLink)) {
        throw new Error(`Unsafe symlink target rejected: "${linkTarget}"`);
      }
      try {
        fs.lstatSync(targetPath);
        fs.rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // does not exist
      }
      try {
        fs.symlinkSync(linkTarget, targetPath);
      } catch {
        deferredWindowsSymlinks.push({ targetPath, resolvedLink });
      }
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      assertParentRealpathWithinRoot(rootReal, targetPath);
      try {
        const st = fs.lstatSync(targetPath);
        if (st.isSymbolicLink()) {
          fs.unlinkSync(targetPath);
        }
      } catch {
        // does not exist
      }
      fs.writeFileSync(targetPath, data);
      if (process.platform !== "win32" && (mode & 0o111) !== 0) {
        fs.chmodSync(targetPath, mode & 0o777);
      }
    }
  }

  for (const item of deferredWindowsSymlinks) {
    if (fs.existsSync(item.resolvedLink) && fs.statSync(item.resolvedLink).isFile()) {
      fs.copyFileSync(item.resolvedLink, item.targetPath);
    }
  }
}

function runGitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: buildSanitizedEnv(),
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function createLeakProofWorkspace(
  repoPath: string,
  baseSha: string,
  options?: { prefix?: string; baseTempDir?: string },
): LeakProofWorkspace {
  const validBaseSha = assertValidSha("baseSha", baseSha);
  const parentDir = options?.baseTempDir ? path.resolve(options.baseTempDir) : os.tmpdir();
  fs.mkdirSync(parentDir, { recursive: true });

  const workspaceDir = fs.mkdtempSync(path.join(parentDir, options?.prefix ?? "commitbench-ws-"));
  let initialCommitSha = "";

  try {
    // Export exact tree object via ^{tree} so git neither emits pax_global_header nor expands export-subst SHAs.
    const tarBuffer = execFileSync("git", ["archive", "--format=tar", `${validBaseSha}^{tree}`], {
      cwd: repoPath,
      env: buildSanitizedEnv(),
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });

    extractTarBuffer(tarBuffer, workspaceDir);

    // Initialize brand-new isolated repo with one squashed commit, zero remotes, zero tags, zero reflogs.
    runGitSync(workspaceDir, ["init", "--template=", "-b", "main"]);
    fs.appendFileSync(
      path.join(workspaceDir, ".git", "config"),
      "\n[user]\n\tname = commitbench\n\temail = commitbench@local\n[core]\n\tautocrlf = false\n\tlogAllRefUpdates = false\n\thooksPath = \n[commit]\n\tgpgsign = false\n",
      "utf8",
    );
    runGitSync(workspaceDir, ["add", "-f", "-A"]);
    runGitSync(workspaceDir, [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=",
      "commit",
      "-m",
      "Initial commit",
      "--no-verify",
      "--allow-empty",
    ]);
    initialCommitSha = runGitSync(workspaceDir, ["rev-parse", "HEAD"]).trim();

    // Explicitly strip any reflogs or stray head markers.
    const logsDir = path.join(workspaceDir, ".git", "logs");
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch (err) {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }

  return {
    dir: workspaceDir,
    initialCommitSha,
    cleanup: () => {
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function verifyZeroGitLeak(workspaceDir: string, fixSha: string): LeakCheckResult {
  const validFixSha = assertValidSha("fixSha", fixSha);
  const violations: string[] = [];

  try {
    const dotGitPath = path.join(workspaceDir, ".git");
    if (!fs.existsSync(dotGitPath) || !fs.lstatSync(dotGitPath).isDirectory()) {
      violations.push("Workspace .git is missing or not a real directory");
    }

    if (fs.existsSync(path.join(dotGitPath, "objects", "info", "alternates"))) {
      violations.push("Unexpected .git/objects/info/alternates pointer present");
    }

    for (const stray of ["FETCH_HEAD", "ORIG_HEAD"]) {
      if (fs.existsSync(path.join(dotGitPath, stray))) {
        violations.push(`Unexpected .git/${stray} file present`);
      }
    }

    if (fs.existsSync(path.join(workspaceDir, "pax_global_header"))) {
      violations.push("Unexpected pax_global_header file extracted into workspace");
    }

    const revCountRaw = runGitSync(workspaceDir, ["rev-list", "--all", "--count"]).trim();
    const commitCount = Number.parseInt(revCountRaw, 10);
    if (commitCount !== 1) {
      violations.push(`Expected exactly 1 commit in git history, found ${revCountRaw}`);
    }

    const logLines = runGitSync(workspaceDir, ["log", "--all", "--oneline"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (logLines.length !== 1) {
      violations.push(`Expected git log --all to show 1 commit, found ${logLines.length}`);
    }

    const subject = runGitSync(workspaceDir, ["log", "-1", "--format=%s"]).trim();
    if (subject !== "Initial commit") {
      violations.push(`Unexpected initial commit subject: "${subject}"`);
    }

    const refs = runGitSync(workspaceDir, ["for-each-ref", "--format=%(refname)"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const unexpectedRefs = refs.filter((r) => r !== "refs/heads/main");
    if (unexpectedRefs.length > 0) {
      violations.push(`Unexpected git refs present: ${unexpectedRefs.join(", ")}`);
    }

    const remotes = runGitSync(workspaceDir, ["remote"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (remotes.length > 0) {
      violations.push(`Unexpected git remotes present: ${remotes.join(", ")}`);
    }

    const tags = runGitSync(workspaceDir, ["tag", "--list"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (tags.length > 0) {
      violations.push(`Unexpected git tags present: ${tags.join(", ")}`);
    }

    let fixShaPresent = false;
    try {
      execFileSync("git", ["cat-file", "-e", validFixSha], {
        cwd: workspaceDir,
        env: buildSanitizedEnv(),
        stdio: ["ignore", "ignore", "ignore"],
      });
      fixShaPresent = true;
      violations.push(`Future fix commit ${validFixSha} exists in workspace .git object store`);
    } catch {
      fixShaPresent = false;
    }

    const logsDir = path.join(dotGitPath, "logs");
    const reflogsPresent = fs.existsSync(logsDir);
    if (reflogsPresent) {
      violations.push("Git reflogs directory (.git/logs) is present in isolated workspace");
    }

    return {
      passed: violations.length === 0,
      commitCount: Number.isNaN(commitCount) ? -1 : commitCount,
      remotes,
      tags,
      fixShaPresent,
      reflogsPresent,
      violations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      commitCount: -1,
      remotes: [],
      tags: [],
      fixShaPresent: false,
      reflogsPresent: false,
      violations: [...violations, `Git leak verification failed: ${message}`],
    };
  }
}

export function resetTestFiles(
  workspaceDir: string,
  testFiles: string[],
  baselineRef = "HEAD",
): void {
  const baselineFiles = new Set(
    runGitSync(workspaceDir, ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", "--name-only", baselineRef])
      .split("\0")
      .filter((line) => line.length > 0),
  );

  // Protect both the task's hidden test files and all baseline tracked test files from agent tampering.
  const trackedToRestore = new Set<string>();
  for (const file of baselineFiles) {
    if (isTestFile(file)) {
      trackedToRestore.add(file);
    }
  }

  for (const file of testFiles) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.startsWith("-") || normalized.split("/").includes("..")) {
      throw new Error(`Unsafe test file path: "${file}"`);
    }
    if (baselineFiles.has(normalized)) {
      trackedToRestore.add(normalized);
    } else {
      const target = resolveSafeTarget(workspaceDir, normalized);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }

  // Delete any untracked test files created by the agent (e.g., rogue test overrides).
  const statusRaw = runGitSync(workspaceDir, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "-z",
    "-uall",
  ]);
  for (const entry of statusRaw.split("\0")) {
    if (entry.startsWith("?? ")) {
      const rel = entry.slice(3);
      if (rel && isTestFile(rel) && !baselineFiles.has(rel)) {
        const target = resolveSafeTarget(workspaceDir, rel);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  }

  // Also delete any test files added via agent commits after baselineRef.
  const addedRaw = runGitSync(workspaceDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "--diff-filter=A",
    "-z",
    baselineRef,
  ]);
  for (const rel of addedRaw.split("\0")) {
    if (rel && isTestFile(rel) && !baselineFiles.has(rel)) {
      const target = resolveSafeTarget(workspaceDir, rel);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }

  if (trackedToRestore.size > 0) {
    runGitSync(workspaceDir, ["checkout", baselineRef, "--", ...trackedToRestore]);
  }
}

export function applyTestPatch(
  workspaceDir: string,
  testPatch: string,
): { applied: boolean; error?: string } {
  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: workspaceDir,
      env: buildSanitizedEnv(),
      input: testPatch,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { applied: true };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : err instanceof Error
          ? err.message
          : String(err);
    return { applied: false, error: stderr.trim() || "git apply failed" };
  }
}

export function getChangedFiles(workspaceDir: string, baselineRef?: string): string[] {
  const files = new Set<string>();
  if (baselineRef) {
    const diffOut = runGitSync(workspaceDir, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "-z",
      baselineRef,
    ]);
    for (const rel of diffOut.split("\0")) {
      if (rel) files.add(rel);
    }
  }
  const status = runGitSync(workspaceDir, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "-z",
    "-uall",
  ]);
  for (const entry of status.split("\0")) {
    if (entry.length >= 4) {
      const filePart = entry.slice(3);
      if (filePart) {
        files.add(filePart);
      }
    }
  }
  return Array.from(files).sort();
}

export function terminateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3000,
      });
    } catch {
      // Process may already have terminated or timed out.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may already have terminated.
      }
    }
  }
}

export function runCommandWithTimeout(
  command: string,
  options: RunCommandOptions,
): Promise<CommandRunResult> {
  const startMs = Date.now();

  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const safeEnv = options.env ?? buildSanitizedEnv();
    const child = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          cwd: options.cwd,
          env: safeEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn("sh", ["-c", command], {
          cwd: options.cwd,
          env: safeEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceResolveTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceResolveTimer) {
        clearTimeout(forceResolveTimer);
      }
      resolve({
        exitCode,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout,
        stderr,
      });
    };

    const appendLimited = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        return current;
      }
      const next = current + chunk.toString("utf8");
      return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        terminateProcessTree(child.pid);
      }
      forceResolveTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(124);
      }, 1_500);
    }, Math.max(100, options.timeoutMs));

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(1);
    });

    child.on("close", (code) => {
      finish(timedOut ? 124 : (code ?? 1));
    });
  });
}
