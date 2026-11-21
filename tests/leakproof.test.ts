import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoFixture } from "../src/demo/fixture.js";
import { mineTasks } from "../src/git/miner.js";
import {
  applyTestPatch,
  createLeakProofWorkspace,
  extractTarBuffer,
  resetTestFiles,
  runCommandWithTimeout,
  verifyZeroGitLeak,
} from "../src/sandbox/leakproof.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

describe("leak-proof sandbox", () => {
  it("exports an exact baseSha tree with 1 squashed commit, 0 remotes, 0 tags, 0 reflogs, and no fixSha", () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 15 });
    expect(tasks.length).toBeGreaterThan(0);

    for (const task of tasks) {
      const ws = createLeakProofWorkspace(fixture.repoDir, task.baseSha);
      cleanups.push(ws.cleanup);

      const leak = verifyZeroGitLeak(ws.dir, task.fixSha);
      expect(leak.passed).toBe(true);
      expect(leak.violations).toEqual([]);
      expect(leak.commitCount).toBe(1);
      expect(leak.remotes).toEqual([]);
      expect(leak.tags).toEqual([]);
      expect(leak.fixShaPresent).toBe(false);
      expect(leak.reflogsPresent).toBe(false);

      // Ensure pax_global_header was never written to disk.
      expect(fs.existsSync(path.join(ws.dir, "pax_global_header"))).toBe(false);

      // Verify git log --all has only Initial commit.
      const logOut = execFileSync("git", ["log", "--all", "--format=%s"], {
        cwd: ws.dir,
        encoding: "utf8",
      }).trim();
      expect(logOut).toBe("Initial commit");
    }
  });

  it("detects deliberate git leaks (remotes, tags, extra commits, reflogs, and present fixSha)", () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 1 });
    const task = tasks[0]!;

    const ws = createLeakProofWorkspace(fixture.repoDir, task.baseSha);
    cleanups.push(ws.cleanup);

    // Introduce leaks deliberately.
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/leak.git"], {
      cwd: ws.dir,
    });
    execFileSync("git", ["tag", "v9.9.9"], { cwd: ws.dir });
    fs.writeFileSync(path.join(ws.dir, "extra.txt"), "extra", "utf8");
    execFileSync("git", ["add", "extra.txt"], { cwd: ws.dir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: ws.dir });
    const secondSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ws.dir,
      encoding: "utf8",
    }).trim();
    fs.mkdirSync(path.join(ws.dir, ".git", "logs"), { recursive: true });

    const leak = verifyZeroGitLeak(ws.dir, secondSha);
    expect(leak.passed).toBe(false);
    expect(leak.commitCount).toBe(2);
    expect(leak.remotes).toEqual(["origin"]);
    expect(leak.tags).toEqual(["v9.9.9"]);
    expect(leak.fixShaPresent).toBe(true);
    expect(leak.reflogsPresent).toBe(true);
    expect(leak.violations.length).toBeGreaterThanOrEqual(5);
  });

  it("resets tampered test files and applies hidden testPatch cleanly", () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 1 });
    const task = tasks[0]!;
    const ws = createLeakProofWorkspace(fixture.repoDir, task.baseSha);
    cleanups.push(ws.cleanup);

    // Simulate a cheating agent overwriting a test file.
    const testPath = path.join(ws.dir, task.testFiles[0]!);
    fs.writeFileSync(testPath, "// agent tampered with test\n", "utf8");

    resetTestFiles(ws.dir, task.testFiles);
    const patchRes = applyTestPatch(ws.dir, task.testPatch);
    expect(patchRes.applied).toBe(true);
  });

  it("terminates timed-out command trees cleanly without hanging", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commitbench-timeout-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const nodeCmd = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
    const start = Date.now();
    const res = await runCommandWithTimeout(nodeCmd, {
      cwd: tmp,
      timeoutMs: 350,
    });
    const elapsed = Date.now() - start;

    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("rejects tar archive path traversal entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commitbench-tar-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // Build a minimal 512-byte ustar header with "../escape.txt".
    const header = Buffer.alloc(1536, 0);
    header.write("../escape.txt", 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("00000000004\0", 124, "utf8");
    header.write("0", 156, "utf8");
    header.write("test", 512, "utf8");

    expect(() => extractTarBuffer(header, tmp)).toThrow(/Unsafe archive entry path/);
  });
});
