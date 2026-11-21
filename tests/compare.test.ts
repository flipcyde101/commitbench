import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoFixture } from "../src/demo/fixture.js";
import { mineTasks } from "../src/git/miner.js";
import { compareVariants, validateTask } from "../src/runner/compare.js";
import { RunStore } from "../src/runner/store.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("pre-flight validation and A/B comparison runner", () => {
  it("validates all 3 fixture tasks (baseSha + testPatch fails, fixSha passes)", async () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 15 });
    expect(tasks).toHaveLength(3);

    for (const task of tasks) {
      const val = await validateTask(task, {
        testCommand: fixture.testCommand,
        timeoutMs: 30_000,
      });
      expect(val.valid).toBe(true);
      expect(val.baseFails).toBe(true);
      expect(val.fixPasses).toBe(true);
      expect(val.leakCheckPassed).toBe(true);
    }
  });

  it("rejects a task whose hidden test already passes on baseSha", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commitbench-nonrepro-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: tmp, encoding: "utf8" });

    git(["init", "-b", "main"]);
    git(["config", "user.name", "Tester"]);
    git(["config", "user.email", "tester@example.local"]);
    git(["config", "core.autocrlf", "false"]);

    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "math.mjs"), "export const add = (a, b) => a + b;\n");
    fs.writeFileSync(
      path.join(tmp, "tests", "math.test.mjs"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\ntest("adds", () => assert.equal(add(1, 2), 3));\n',
    );
    git(["add", "-A"]);
    git(["commit", "-m", "initial"]);

    // Add a trivial test that ALREADY passes on baseSha.
    fs.writeFileSync(path.join(tmp, "src", "math.mjs"), "export const add = (a, b) => a + b; // comment\n");
    fs.writeFileSync(
      path.join(tmp, "tests", "math.test.mjs"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\ntest("adds", () => assert.equal(add(1, 2), 3));\ntest("still adds", () => assert.equal(add(2, 2), 4));\n',
    );
    git(["add", "-A"]);
    git(["commit", "-m", "chore: add passing test"]);

    const tasks = mineTasks({ repoPath: tmp, days: 45, limit: 5 });
    expect(tasks).toHaveLength(1);

    const val = await validateTask(tasks[0]!, {
      testCommand: `"${process.execPath}" --test`,
      timeoutMs: 15_000,
    });
    expect(val.valid).toBe(false);
    expect(val.baseFails).toBe(false);
    expect(val.reason).toContain("does not reproduce the bug");
  });

  it("runs A/B comparison, persists to SQLite WAL store, and catches regressions & test tampering", async () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasks = mineTasks({ repoPath: fixture.repoDir, days: 45, limit: 15 });
    const dbPath = path.join(fixture.rootDir, "runs.sqlite");

    const report = await compareVariants({
      repoPath: fixture.repoDir,
      tasks,
      variantA: fixture.variantA,
      variantB: fixture.variantB,
      testCommand: fixture.testCommand,
      concurrency: 2,
      agentTimeoutMs: 30_000,
      testTimeoutMs: 30_000,
      validateFirst: true,
      dbPath,
    });

    expect(report.taskCount).toBe(3);
    expect(report.validTaskCount).toBe(3);
    expect(report.leakViolationsTotal).toBe(0);
    expect(report.variants[0].passedCount).toBe(1);
    expect(report.variants[0].passRate).toBe(33.3);
    expect(report.variants[1].passedCount).toBe(3);
    expect(report.variants[1].passRate).toBe(100);
    expect(report.deltaPassedCount).toBe(2);
    expect(report.deltaPassRate).toBe(66.7);
    expect(report.winner).toBe("B");

    // Verify SQLite WAL persistence.
    const store = new RunStore(dbPath);
    try {
      expect(store.getJournalMode().toLowerCase()).toBe("wal");
      const runs = store.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.runId).toBe(report.runId);
      const saved = store.getReport(report.runId);
      expect(saved?.winner).toBe("B");
      expect(store.getTaskResults(report.runId)).toHaveLength(6);
      expect(store.getValidations(report.runId)).toHaveLength(3);
    } finally {
      store.close();
    }

    // Verify test-tampering prevention and pass_to_pass regression detection.
    const tamperScript = path.join(fixture.rootDir, "tamper-agent.mjs");
    fs.writeFileSync(
      tamperScript,
      `import fs from "node:fs";
import path from "node:path";
const wd = process.env.COMMITBENCH_WORKDIR;
// Break a source file AND overwrite all tests with empty files.
fs.writeFileSync(path.join(wd, "src", "pricing.mjs"), "export function calculateTotal() { return -999; }\\n");
for (const name of fs.readdirSync(path.join(wd, "tests"))) {
  fs.writeFileSync(path.join(wd, "tests", name), "");
}
`,
      "utf8",
    );

    const tamperReport = await compareVariants({
      repoPath: fixture.repoDir,
      tasks: tasks.slice(0, 1),
      variantA: {
        id: "A",
        label: "Tampering agent",
        command: `"${process.execPath}" "${tamperScript}"`,
      },
      variantB: fixture.variantB,
      testCommand: fixture.testCommand,
      concurrency: 1,
      validateFirst: false,
      dbPath: path.join(fixture.rootDir, "tamper.sqlite"),
    });

    const resA = tamperReport.results.find((r) => r.variantId === "A");
    expect(resA?.passed).toBe(false);
    expect(resA?.passToPass).toBe(false);
  });
});
