import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestFile } from "../git/miner.js";
import type { LeakCheckResult } from "../types.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export interface LeakProofWorkspace {
  dir: string;
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
  const text = data.toString("utf8");
  let cursor = 0;
  while (cursor < text.length) {
    const spaceIdx = text.indexOf(" ", cursor);
    if (spaceIdx === -1) {
      break;
    }
    const lenStr = text.slice(cursor, spaceIdx);
    const recordLen = Number.parseInt(lenStr, 10);
    if (!Number.isFinite(recordLen) || recordLen <= 0) {
      break;
    }
    const entryEnd = cursor + recordLen;
    const body = text.slice(spaceIdx + 1, Math.max(spaceIdx + 1, entryEnd - 1));
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

function resolveSafeTarget(destDir: string, entryName: string): string {
  const cleaned = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = path.resolve(destDir);
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Unsafe archive entry path rejected: "${entryName}"`);
  }
  return target;
}

export function extractTarBuffer(tarBuffer: Buffer, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let pendingPax: Record<string, string> = {};

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
    const size = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const linkNameField = readTarString(header, 157, 100);
    const prefixField = readTarString(header, 345, 155);

    offset += 512;
    const dataEnd = offset + size;
    const data = tarBuffer.subarray(offset, dataEnd);
    const paddedBlocks = Math.ceil(size / 512) * 512;
    offset += paddedBlocks;

    // Ignore global PAX header (git archive embeds commit SHA comments here).
    if (typeFlag === "g") {
      continue;
    }

    // Per-file PAX extended header (used for long paths > 100 chars).
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
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (typeFlag === "2") {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const resolvedLink = path.resolve(path.dirname(targetPath), linkTarget);
      const root = path.resolve(destDir);
      if (resolvedLink !== root && !resolvedLink.startsWith(root + path.sep)) {
        throw new Error(`Unsafe symlink target rejected: "${linkTarget}"`);
      }
      try {
        fs.symlinkSync(linkTarget, targetPath);
      } catch {
        // On Windows without Developer Mode, fallback to copying file content if possible.
        if (fs.existsSync(resolvedLink) && fs.statSync(resolvedLink).isFile()) {
          fs.copyFileSync(resolvedLink, targetPath);
        }
      }
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, data);
      if (process.platform !== "win32" && (mode & 0o111) !== 0) {
        fs.chmodSync(targetPath, mode & 0o777);
      }
    }
  }
}

function runGitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
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

  try {
    // Export exact tree snapshot via git archive (contains zero .git history).
    const tarBuffer = execFileSync("git", ["archive", "--format=tar", validBaseSha], {
      cwd: repoPath,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });

    extractTarBuffer(tarBuffer, workspaceDir);

    // Initialize brand-new isolated repo with one squashed commit, zero remotes, zero tags, zero reflogs.
    runGitSync(workspaceDir, ["init", "-b", "main"]);
    fs.appendFileSync(
      path.join(workspaceDir, ".git", "config"),
      "\n[user]\n\tname = commitbench\n\temail = commitbench@local\n[core]\n\tautocrlf = false\n\tlogAllRefUpdates = false\n",
      "utf8",
    );
    runGitSync(workspaceDir, ["add", "-A"]);
    runGitSync(workspaceDir, ["commit", "-m", "Initial commit", "--no-verify"]);

    // Explicitly strip any reflogs or stray head markers.
    const logsDir = path.join(workspaceDir, ".git", "logs");
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw err;
  }

  return {
    dir: workspaceDir,
    cleanup: () => {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

export function verifyZeroGitLeak(workspaceDir: string, fixSha: string): LeakCheckResult {
  const validFixSha = assertValidSha("fixSha", fixSha);
  const violations: string[] = [];

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
    execFileSync("git", ["cat-file", "-e", `${validFixSha}^{commit}`], {
      cwd: workspaceDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    fixShaPresent = true;
    violations.push(`Future fix commit ${validFixSha} exists in workspace .git object store`);
  } catch {
    fixShaPresent = false;
  }

  const logsDir = path.join(workspaceDir, ".git", "logs");
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
}

export function resetTestFiles(workspaceDir: string, testFiles: string[]): void {
  const trackedFiles = new Set(
    runGitSync(workspaceDir, ["ls-files"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  // Protect both the task's hidden test files and all tracked test files from agent tampering.
  const trackedToRestore = new Set<string>();
  for (const file of trackedFiles) {
    if (isTestFile(file)) {
      trackedToRestore.add(file);
    }
  }

  for (const file of testFiles) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.startsWith("-") || normalized.includes("..")) {
      throw new Error(`Unsafe test file path: "${file}"`);
    }
    if (trackedFiles.has(normalized)) {
      trackedToRestore.add(normalized);
    } else {
      const target = resolveSafeTarget(workspaceDir, normalized);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    }
  }

  if (trackedToRestore.size > 0) {
    runGitSync(workspaceDir, ["checkout", "HEAD", "--", ...trackedToRestore]);
  }
}

export function applyTestPatch(
  workspaceDir: string,
  testPatch: string,
): { applied: boolean; error?: string } {
  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: workspaceDir,
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

export function getChangedFiles(workspaceDir: string): string[] {
  const status = runGitSync(workspaceDir, ["status", "--porcelain"]);
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (line.length >= 4) {
      const filePart = line.slice(3).trim();
      if (filePart) {
        files.push(filePart);
      }
    }
  }
  return files;
}

export function terminateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Process may already have terminated.
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
    const child = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn("sh", ["-c", command], {
          cwd: options.cwd,
          env: options.env ?? process.env,
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
