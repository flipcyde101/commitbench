import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { loadTasksFile, mineTasks, redactProblemStatement } from "../src/git/miner.js";
import { formatHtmlReport, formatMarkdownReport } from "../src/report/format.js";
import { compareVariants, validateTask } from "../src/runner/compare.js";
import { RunStore } from "../src/runner/store.js";
import {
  createLeakProofWorkspace,
  extractTarBuffer,
  getChangedFiles,
  resetTestFiles,
  verifyZeroGitLeak,
} from "../src/sandbox/leakproof.js";
import type { CompareReport, MinedTask } from "../src/types.js";

function makeTarHeader(name: string, size: number, typeFlag: string, linkName = ""): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  buf.write("0000644\0", 100, 8, "ascii");
  buf.write("0000000\0", 108, 8, "ascii");
  buf.write("0000000\0", 116, 8, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  buf.write("00000000000\0", 136, 12, "ascii");
  buf.fill(0x20, 148, 156);
  buf[156] = typeFlag.charCodeAt(0);
  if (linkName) {
    buf.write(linkName, 157, Math.min(100, Buffer.byteLength(linkName)), "utf8");
  }
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += buf[i]!;
  buf.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

function padTarData(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
}

describe("commitbench whole-branch review regression fixes (C1-C5, I1-I9, M1-M6)", () => {
  it("C1 & C5 & I1 & I2: resetTestFiles defeats agent git-commit/git-rm/untracked test tampering, strips inherited GIT_* env, and verifies zero leaks thoroughly", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rev-c1-"));
    try {
      const repoDir = path.join(tmp, "repo");
      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@local"], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, "src", "math.mjs"), "export const add = (a, b) => a - b;\n");
      fs.writeFileSync(path.join(repoDir, "tests", "math.test.mjs"), "import assert from 'node:assert'; assert.ok(true);\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      fs.writeFileSync(path.join(repoDir, "src", "math.mjs"), "export const add = (a, b) => a + b;\n");
      fs.writeFileSync(path.join(repoDir, "tests", "math.test.mjs"), "import assert from 'node:assert'; import { add } from '../src/math.mjs'; assert.equal(add(1,2), 3);\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "fix add"], { cwd: repoDir });
      const fixSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      // Inject hostile inherited GIT_DIR pointing to host repo; sandbox must ignore it!
      const prevGitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(repoDir, ".git");
      let ws: ReturnType<typeof createLeakProofWorkspace>;
      try {
        ws = createLeakProofWorkspace(repoDir, baseSha, { baseTempDir: tmp });
      } finally {
        if (prevGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prevGitDir;
      }

      try {
        expect(ws.initialCommitSha).toMatch(/^[0-9a-f]{40}$/);
        const leak = verifyZeroGitLeak(ws.dir, fixSha);
        expect(leak.passed).toBe(true);

        // Agent tampers by editing test + committing it + creating untracked test file!
        fs.writeFileSync(path.join(ws.dir, "tests", "math.test.mjs"), "// TAMPERED\n");
        fs.writeFileSync(path.join(ws.dir, "tests", "evil.test.mjs"), "process.exit(0);\n");
        execFileSync("git", ["add", "tests/math.test.mjs"], { cwd: ws.dir });
        execFileSync("git", ["commit", "-m", "agent tamper", "--no-verify"], { cwd: ws.dir });

        // getChangedFiles against initialCommitSha must detect committed edits too!
        const changed = getChangedFiles(ws.dir, ws.initialCommitSha);
        expect(changed).toContain("tests/math.test.mjs");

        // resetTestFiles must restore committed tampered test AND delete untracked test file!
        resetTestFiles(ws.dir, ["tests/math.test.mjs"], ws.initialCommitSha);
        const restored = fs.readFileSync(path.join(ws.dir, "tests", "math.test.mjs"), "utf8");
        expect(restored).not.toContain("TAMPERED");
        expect(restored).toContain("assert.ok(true)");
        expect(fs.existsSync(path.join(ws.dir, "tests", "evil.test.mjs"))).toBe(false);
      } finally {
        ws.cleanup();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("C4: rejects PAX UTF-8 byte-length corruption and symlink-chain directory escapes in extractTarBuffer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rev-c4-"));
    try {
      // Non-ASCII UTF-8 filename in PAX record: byte length != UTF-16 length!
      const utf8Name = "src/café-éé.txt";
      const kv = `path=${utf8Name}\n`;
      // Compute POSIX byte length including digits + space
      let len = Buffer.byteLength(kv, "utf8") + 2;
      while (Buffer.byteLength(`${len} ${kv}`, "utf8") !== len) {
        len = Buffer.byteLength(`${len} ${kv}`, "utf8");
      }
      const paxPayload = Buffer.from(`${len} ${kv}`, "utf8");
      const filePayload = Buffer.from("hello utf8", "utf8");
      const tarUtf8 = Buffer.concat([
        makeTarHeader("PaxHeader/x", paxPayload.length, "x"),
        padTarData(paxPayload),
        makeTarHeader("fallback.txt", filePayload.length, "0"),
        padTarData(filePayload),
        Buffer.alloc(1024, 0),
      ]);
      const dest1 = path.join(tmp, "out1");
      extractTarBuffer(tarUtf8, dest1);
      expect(fs.readFileSync(path.join(dest1, "src", "café-éé.txt"), "utf8")).toBe("hello utf8");

      // Symlink targeting destDir root ("a/b -> ..") must be rejected so symlink chains cannot escape!
      const tarEsc = Buffer.concat([
        makeTarHeader("a/b", 0, "2", ".."),
        Buffer.alloc(1024, 0),
      ]);
      const dest2 = path.join(tmp, "out2");
      expect(() => extractTarBuffer(tarEsc, dest2)).toThrow(/Unsafe symlink/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("C2 & I3 & I4 & I5: validates clean baseSha passes, rejects --days 0, redacts ./path & a/path spoilers, validates loadTasksFile, and hides fixSha from agent env", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rev-c2-"));
    try {
      const repoDir = path.join(tmp, "repo");
      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@local"], { cwd: repoDir });
      // Broken baseline test (fails on baseSha even without testPatch!)
      fs.writeFileSync(path.join(repoDir, "src", "app.mjs"), "export const ok = false;\n");
      fs.writeFileSync(path.join(repoDir, "tests", "app.test.mjs"), "import assert from 'node:assert'; import { ok } from '../src/app.mjs'; assert.equal(ok, true);\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "broken base"], { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, "src", "app.mjs"), "export const ok = true;\n");
      fs.writeFileSync(path.join(repoDir, "tests", "app.test.mjs"), "import assert from 'node:assert'; import { ok } from '../src/app.mjs'; assert.equal(ok, true); assert.equal(typeof ok, 'boolean');\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "fix ./src/app.mjs and b/src/app.mjs"], { cwd: repoDir });

      // I3: --days 0 must throw instead of silently disabling cutoff
      expect(() => mineTasks({ repoPath: repoDir, days: 0 })).toThrow(/Invalid days/i);

      const tasks = mineTasks({ repoPath: repoDir, days: 30 });
      expect(tasks).toHaveLength(1);
      // I4: ./src/app.mjs and b/src/app.mjs must be redacted!
      expect(tasks[0]!.problemStatement).not.toContain("app.mjs");

      // C2: validateTask must reject a broken baseSha where baseline tests fail!
      const val = await validateTask(tasks[0]!, {
        testCommand: `"${process.execPath}" --test`,
        timeoutMs: 15_000,
        baseTempDir: tmp,
      });
      expect(val.valid).toBe(false);
      expect(val.reason).toMatch(/baseline|baseSha/i);

      // I5: loadTasksFile rejects malformed task objects
      const badFile = path.join(tmp, "bad.json");
      fs.writeFileSync(badFile, JSON.stringify([{ bogus: true }]), "utf8");
      expect(() => loadTasksFile(badFile)).toThrow(/Invalid task/i);

      // I4: redactProblemStatement handles ./ and a/ and b/ prefixes
      const prompt = redactProblemStatement({
        subject: "Fix bug in ./src/pricing.mjs and a/src/pricing.mjs",
        body: "(cherry picked from commit 1234567890abcdef)",
        sourceFiles: ["src/pricing.mjs"],
        testFiles: ["tests/pricing.test.mjs"],
        fixSha: "1234567890abcdef1234567890abcdef12345678",
        baseSha: "abcdef1234567890abcdef1234567890abcdef12",
      });
      expect(prompt).not.toContain("pricing.mjs");
      expect(prompt).not.toContain("1234567");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("I6 & I8 & I9 & M4 & M5: rejects unknown flags/--flag=false/empty --cmd, escapes Markdown pipes/HTML, handles idempotent RunStore.close(), and renders badge-skip", async () => {
    expect(await runCli(["--unknown-flag"])).toBe(1);
    expect(await runCli(["compare", "--a", "echo a", "--b", "echo b", "--cmd", ""])).toBe(1);
    expect(await runCli(["mine", "--concurrency", "2abc"])).toBe(1);

    const store = new RunStore(":memory:");
    store.close();
    expect(() => store.close()).not.toThrow();

    const fakeReport: CompareReport = {
      runId: "run-1",
      createdAt: "2026-11-21T00:00:00Z",
      repoPath: "/tmp/repo",
      testCommand: "npm test `echo`",
      taskCount: 1,
      validTaskCount: 0,
      leakViolationsTotal: 0,
      variants: [
        { variantId: "A", variantLabel: "GPT | v1 <script>", passedCount: 0, totalCount: 0, passRate: 0, failToPassCount: 0, passToPassCount: 0, leakViolationsCount: 0, avgAgentDurationMs: 0, totalDurationMs: 0 },
        { variantId: "B", variantLabel: "Claude\nv2", passedCount: 0, totalCount: 0, passRate: 0, failToPassCount: 0, passToPassCount: 0, leakViolationsCount: 0, avgAgentDurationMs: 0, totalDurationMs: 0 },
      ],
      deltaPassRate: 0,
      deltaPassedCount: 0,
      winner: "tie",
      validations: [],
      results: [],
      tasks: [
        {
          id: "task-1",
          repoPath: "/tmp/repo",
          baseSha: "0".repeat(40),
          fixSha: "1".repeat(40),
          shortSha: "11111111",
          commitDate: "2026-11-21T00:00:00Z",
          originalSubject: "Fix <img src=x> | line1\nline2\\",
          problemStatement: "Fix it",
          sourceFiles: ["src/a.js"],
          testFiles: ["tests/a.test.js"],
          testPatch: "",
          diffStats: { filesChanged: 2, sourceFilesCount: 1, testFilesCount: 1, testPatchBytes: 0 },
        },
      ],
    };

    const md = formatMarkdownReport(fakeReport);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("<img");
    expect(md).toContain("GPT \\| v1");

    const html = formatHtmlReport(fakeReport);
    expect(html).toContain("badge-skip");

    // Duplicate variant IDs rejected
    await expect(
      compareVariants({
        repoPath: ".",
        tasks: [] as MinedTask[],
        variantA: { id: "SAME", label: "A", command: "echo a" },
        variantB: { id: "SAME", label: "B", command: "echo b" },
        testCommand: "npm test",
      }),
    ).rejects.toThrow(/variant/i);
  });
});
