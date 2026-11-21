import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoFixture } from "../src/demo/fixture.js";
import {
  isSourceFile,
  isTestFile,
  loadTasksFile,
  mineTasks,
  redactProblemStatement,
  saveTasksFile,
} from "../src/git/miner.js";

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("git miner", () => {
  it("classifies source files and test files accurately", () => {
    expect(isTestFile("tests/pricing.test.mjs")).toBe(true);
    expect(isTestFile("src/__tests__/auth.ts")).toBe(true);
    expect(isTestFile("pkg/slug_test.go")).toBe(true);
    expect(isTestFile("python/test_billing.py")).toBe(true);
    expect(isTestFile("src/pricing.mjs")).toBe(false);

    expect(isSourceFile("src/pricing.mjs")).toBe(true);
    expect(isSourceFile("src/auth.ts")).toBe(true);
    expect(isSourceFile("tests/pricing.test.mjs")).toBe(false);
    expect(isSourceFile("package-lock.json")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
  });

  it("mines only commits touching both source and test files and splits baseSha/fixSha/testPatch", () => {
    const fixture = createDemoFixture();
    tempDirs.push(fixture.rootDir);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 15 });
    expect(tasks).toHaveLength(3);

    for (const task of tasks) {
      expect(task.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(task.fixSha).toMatch(/^[0-9a-f]{40}$/);
      expect(task.baseSha).not.toBe(task.fixSha);
      expect(task.sourceFiles.length).toBeGreaterThan(0);
      expect(task.testFiles.length).toBeGreaterThan(0);
      expect(task.testPatch).toContain("diff --git");

      // Hidden testPatch must only touch test files, never source files.
      for (const src of task.sourceFiles) {
        expect(task.testPatch).not.toContain(`b/${src}`);
      }
      // Redacted prompt must not spoil exact filenames or commit SHAs.
      for (const file of [...task.sourceFiles, ...task.testFiles]) {
        expect(task.problemStatement).not.toContain(file);
      }
      expect(task.problemStatement).not.toContain(task.fixSha);
      expect(task.problemStatement).not.toContain(task.shortSha);
    }

    // Verify commit~1 matches baseSha.
    const first = tasks[0]!;
    const resolvedParent = execFileSync("git", ["rev-parse", `${first.fixSha}~1`], {
      cwd: fixture.repoDir,
      encoding: "utf8",
    }).trim();
    expect(first.baseSha).toBe(resolvedParent);
  });

  it("redacts commit SHAs, file spoilers, and git trailers cleanly", () => {
    const redacted = redactProblemStatement({
      subject: "fix: reject negative price in src/pricing.mjs (regression from 1a2b3c4d)",
      body: [
        "Follow-up to commit dead1234beef and pricing.test.mjs.",
        "Co-authored-by: Alice <alice@example.com>",
        "Signed-off-by: Bob <bob@example.com>",
      ].join("\n"),
      sourceFiles: ["src/pricing.mjs"],
      testFiles: ["tests/pricing.test.mjs"],
      fixSha: "abcdef1234567890abcdef1234567890abcdef12",
      baseSha: "1a2b3c4d5e6f78901234567890abcdef12345678",
    });

    expect(redacted).not.toContain("src/pricing.mjs");
    expect(redacted).not.toContain("pricing.mjs");
    expect(redacted).not.toContain("pricing.test.mjs");
    expect(redacted).not.toContain("1a2b3c4d");
    expect(redacted).not.toContain("dead1234beef");
    expect(redacted).not.toContain("Co-authored-by");
    expect(redacted).not.toContain("Signed-off-by");
    expect(redacted).toContain("[redacted-file]");
    expect(redacted).toContain("[redacted-sha]");
  });

  it("rejects unsafe arguments and non-git paths", () => {
    const notAGitDir = mkTmp("commitbench-nogit-");
    expect(() => mineTasks({ repoPath: notAGitDir })).toThrow(/git/i);

    const fixture = createDemoFixture();
    tempDirs.push(fixture.rootDir);

    expect(() => mineTasks({ repoPath: fixture.repoDir, since: "--exec=evil" })).toThrow(
      /Invalid --since/,
    );
    expect(() => mineTasks({ repoPath: fixture.repoDir, limit: 0 })).toThrow(/Invalid limit/);
    expect(() => mineTasks({ repoPath: fixture.repoDir, days: 99999 })).toThrow(/Invalid days/);
  });

  it("saves and reloads mined tasks JSON cleanly", () => {
    const fixture = createDemoFixture();
    tempDirs.push(fixture.rootDir);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 2 });
    const outPath = path.join(fixture.rootDir, "tasks.json");
    saveTasksFile(outPath, tasks);
    const loaded = loadTasksFile(outPath);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe(tasks[0]?.id);
    expect(loaded[0]?.testPatch).toBe(tasks[0]?.testPatch);
  });
});
