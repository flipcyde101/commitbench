import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTestPatch,
  createLeakProofWorkspace,
  getChangedFiles,
  resetTestFiles,
  runCommandWithTimeout,
  verifyZeroGitLeak,
} from "../sandbox/leakproof.js";
import type {
  CompareOptions,
  CompareReport,
  MinedTask,
  TaskGradeResult,
  ValidateOptions,
  ValidationResult,
  VariantSpec,
  VariantSummary,
} from "../types.js";
import { RunStore } from "./store.js";

const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

function trimOutput(stdout: string, stderr: string, maxChars = 4000): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) {
        return;
      }
      const item = items[idx];
      if (item !== undefined) {
        results[idx] = await worker(item, idx);
      }
    }
  }

  const workers = Array.from({ length: limit }, () => runNext());
  await Promise.all(workers);
  return results;
}

export async function validateTask(
  task: MinedTask,
  options: ValidateOptions,
): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  // Phase 1: Confirm baseSha + hidden testPatch FAILS and workspace has zero git leaks.
  const baseWs = createLeakProofWorkspace(task.repoPath, task.baseSha, {
    prefix: `commitbench-val-base-${task.shortSha}-`,
    baseTempDir: options.baseTempDir,
  });

  let leakCheckPassed = false;
  let baseFails = false;
  let baseExitCode = -1;
  let baseDurationMs = 0;
  let baseOutput = "";
  let reason: string | undefined;

  try {
    const leak = verifyZeroGitLeak(baseWs.dir, task.fixSha);
    leakCheckPassed = leak.passed;
    if (!leak.passed) {
      reason = `Git leak check failed: ${leak.violations.join("; ")}`;
    } else {
      const patchRes = applyTestPatch(baseWs.dir, task.testPatch);
      if (!patchRes.applied) {
        reason = `Failed to apply hidden testPatch onto baseSha: ${patchRes.error ?? "unknown error"}`;
      } else {
        const baseRun = await runCommandWithTimeout(options.testCommand, {
          cwd: baseWs.dir,
          timeoutMs,
        });
        baseExitCode = baseRun.exitCode;
        baseDurationMs = baseRun.durationMs;
        baseOutput = trimOutput(baseRun.stdout, baseRun.stderr);
        if (baseRun.timedOut) {
          reason = `Base test run timed out after ${timeoutMs}ms`;
        } else if (baseRun.exitCode === 0) {
          reason = "Hidden testPatch passed on baseSha (test does not reproduce the bug)";
        } else {
          baseFails = true;
        }
      }
    }
  } finally {
    baseWs.cleanup();
  }

  if (!leakCheckPassed || !baseFails) {
    return {
      taskId: task.id,
      valid: false,
      baseFails,
      fixPasses: false,
      leakCheckPassed,
      baseExitCode,
      fixExitCode: -1,
      baseDurationMs,
      fixDurationMs: 0,
      reason,
      baseOutput,
    };
  }

  // Phase 2: Confirm fixSha (which includes the fix + tests) PASSES cleanly.
  const fixWs = createLeakProofWorkspace(task.repoPath, task.fixSha, {
    prefix: `commitbench-val-fix-${task.shortSha}-`,
    baseTempDir: options.baseTempDir,
  });

  let fixPasses = false;
  let fixExitCode = -1;
  let fixDurationMs = 0;
  let fixOutput = "";

  try {
    const fixRun = await runCommandWithTimeout(options.testCommand, {
      cwd: fixWs.dir,
      timeoutMs,
    });
    fixExitCode = fixRun.exitCode;
    fixDurationMs = fixRun.durationMs;
    fixOutput = trimOutput(fixRun.stdout, fixRun.stderr);
    if (fixRun.timedOut) {
      reason = `Fix test run timed out after ${timeoutMs}ms`;
    } else if (fixRun.exitCode !== 0) {
      reason = `Tests failed on fixSha (exit code ${fixRun.exitCode})`;
    } else {
      fixPasses = true;
    }
  } finally {
    fixWs.cleanup();
  }

  return {
    taskId: task.id,
    valid: leakCheckPassed && baseFails && fixPasses,
    baseFails,
    fixPasses,
    leakCheckPassed,
    baseExitCode,
    fixExitCode,
    baseDurationMs,
    fixDurationMs,
    reason,
    baseOutput,
    fixOutput,
  };
}

async function runSingleVariantOnTask(params: {
  task: MinedTask;
  variant: VariantSpec;
  testCommand: string;
  agentTimeoutMs: number;
  testTimeoutMs: number;
  baseTempDir?: string;
}): Promise<TaskGradeResult> {
  const { task, variant, testCommand, agentTimeoutMs, testTimeoutMs, baseTempDir } = params;

  const ws = createLeakProofWorkspace(task.repoPath, task.baseSha, {
    prefix: `commitbench-run-${variant.id.toLowerCase()}-${task.shortSha}-`,
    baseTempDir,
  });

  const promptDir = fs.mkdtempSync(
    path.join(baseTempDir ? path.resolve(baseTempDir) : os.tmpdir(), "commitbench-prompt-"),
  );
  const promptFile = path.join(promptDir, `${task.id}.txt`);
  fs.writeFileSync(promptFile, task.problemStatement, "utf8");

  try {
    // Verify leak-proof isolation BEFORE invoking the coding agent.
    const leakBefore = verifyZeroGitLeak(ws.dir, task.fixSha);
    if (!leakBefore.passed) {
      return {
        taskId: task.id,
        variantId: variant.id,
        variantLabel: variant.label,
        passed: false,
        failToPass: false,
        passToPass: false,
        leakCheckPassed: false,
        leakViolations: leakBefore.violations,
        agentExitCode: -1,
        agentTimedOut: false,
        agentDurationMs: 0,
        gradeDurationMs: 0,
        changedFiles: [],
        testPatchApplied: false,
        error: `Pre-agent leak check failed: ${leakBefore.violations.join("; ")}`,
      };
    }

    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...variant.env,
      COMMITBENCH_PROMPT_FILE: promptFile,
      COMMITBENCH_WORKDIR: ws.dir,
      COMMITBENCH_TASK_ID: task.id,
      COMMITBENCH_VARIANT_ID: variant.id,
      COMMITBENCH_VARIANT_LABEL: variant.label,
    };

    const agentRun = await runCommandWithTimeout(variant.command, {
      cwd: ws.dir,
      timeoutMs: agentTimeoutMs,
      env: agentEnv,
    });

    const changedFiles = getChangedFiles(ws.dir);
    const gradeStartMs = Date.now();

    if (agentRun.timedOut) {
      return {
        taskId: task.id,
        variantId: variant.id,
        variantLabel: variant.label,
        passed: false,
        failToPass: false,
        passToPass: false,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: agentRun.exitCode,
        agentTimedOut: true,
        agentDurationMs: agentRun.durationMs,
        gradeDurationMs: Date.now() - gradeStartMs,
        changedFiles,
        testPatchApplied: false,
        error: `Agent command timed out after ${agentTimeoutMs}ms`,
        gradeOutput: trimOutput(agentRun.stdout, agentRun.stderr),
      };
    }

    // Reset any agent edits to hidden test files so agents cannot tamper with evaluation tests.
    resetTestFiles(ws.dir, task.testFiles);

    // Step 1: pass_to_pass check on pre-existing baseline tests after agent's source edits.
    const baselineRun = await runCommandWithTimeout(testCommand, {
      cwd: ws.dir,
      timeoutMs: testTimeoutMs,
    });
    const passToPass = !baselineRun.timedOut && baselineRun.exitCode === 0;

    // Step 2: Apply hidden testPatch and run fail_to_pass check.
    const patchRes = applyTestPatch(ws.dir, task.testPatch);
    if (!patchRes.applied) {
      return {
        taskId: task.id,
        variantId: variant.id,
        variantLabel: variant.label,
        passed: false,
        failToPass: false,
        passToPass,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: agentRun.exitCode,
        agentTimedOut: false,
        agentDurationMs: agentRun.durationMs,
        gradeDurationMs: Date.now() - gradeStartMs,
        changedFiles,
        testPatchApplied: false,
        error: `Failed to apply hidden testPatch: ${patchRes.error ?? "git apply failed"}`,
      };
    }

    const hiddenRun = await runCommandWithTimeout(testCommand, {
      cwd: ws.dir,
      timeoutMs: testTimeoutMs,
    });
    const failToPass = !hiddenRun.timedOut && hiddenRun.exitCode === 0;

    const passed = passToPass && failToPass;
    let error: string | undefined;
    if (baselineRun.timedOut) {
      error = `Baseline pass_to_pass test timed out after ${testTimeoutMs}ms`;
    } else if (hiddenRun.timedOut) {
      error = `Hidden fail_to_pass test timed out after ${testTimeoutMs}ms`;
    } else if (!passToPass) {
      error = `Baseline pass_to_pass check failed (exit code ${baselineRun.exitCode})`;
    } else if (!failToPass) {
      error = `Hidden fail_to_pass test failed (exit code ${hiddenRun.exitCode})`;
    }

    return {
      taskId: task.id,
      variantId: variant.id,
      variantLabel: variant.label,
      passed,
      failToPass,
      passToPass,
      leakCheckPassed: true,
      leakViolations: [],
      agentExitCode: agentRun.exitCode,
      agentTimedOut: false,
      agentDurationMs: agentRun.durationMs,
      gradeDurationMs: Date.now() - gradeStartMs,
      changedFiles,
      testPatchApplied: true,
      error,
      gradeOutput: trimOutput(hiddenRun.stdout, hiddenRun.stderr),
    };
  } finally {
    ws.cleanup();
    fs.rmSync(promptDir, { recursive: true, force: true });
  }
}

function summarizeVariant(
  variant: VariantSpec,
  results: TaskGradeResult[],
): VariantSummary {
  const mine = results.filter((r) => r.variantId === variant.id);
  const totalCount = mine.length;
  const passedCount = mine.filter((r) => r.passed).length;
  const failToPassCount = mine.filter((r) => r.failToPass).length;
  const passToPassCount = mine.filter((r) => r.passToPass).length;
  const leakViolationsCount = mine.reduce((acc, r) => acc + r.leakViolations.length, 0);
  const totalAgentDurationMs = mine.reduce((acc, r) => acc + r.agentDurationMs, 0);
  const totalDurationMs = mine.reduce(
    (acc, r) => acc + r.agentDurationMs + r.gradeDurationMs,
    0,
  );
  const passRate = totalCount === 0 ? 0 : Number(((passedCount / totalCount) * 100).toFixed(1));
  const avgAgentDurationMs =
    totalCount === 0 ? 0 : Math.round(totalAgentDurationMs / totalCount);

  return {
    variantId: variant.id,
    variantLabel: variant.label,
    passedCount,
    totalCount,
    passRate,
    failToPassCount,
    passToPassCount,
    leakViolationsCount,
    avgAgentDurationMs,
    totalDurationMs,
  };
}

export async function compareVariants(options: CompareOptions): Promise<CompareReport> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 16));
  const agentTimeoutMs = options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const testTimeoutMs = options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const validateFirst = options.validateFirst ?? true;

  let validations: ValidationResult[] = [];
  let activeTasks = options.tasks;

  if (validateFirst) {
    validations = await mapWithConcurrency(options.tasks, concurrency, (task) =>
      validateTask(task, {
        testCommand: options.testCommand,
        timeoutMs: testTimeoutMs,
        baseTempDir: options.baseTempDir,
      }),
    );

    const validIds = new Set(validations.filter((v) => v.valid).map((v) => v.taskId));
    activeTasks = options.tasks.filter((task) => validIds.has(task.id));
  }

  interface Job {
    task: MinedTask;
    variant: VariantSpec;
  }

  const jobs: Job[] = [];
  for (const task of activeTasks) {
    jobs.push({ task, variant: options.variantA });
    jobs.push({ task, variant: options.variantB });
  }

  const results = await mapWithConcurrency(jobs, concurrency, (job) =>
    runSingleVariantOnTask({
      task: job.task,
      variant: job.variant,
      testCommand: options.testCommand,
      agentTimeoutMs,
      testTimeoutMs,
      baseTempDir: options.baseTempDir,
    }),
  );

  const summaryA = summarizeVariant(options.variantA, results);
  const summaryB = summarizeVariant(options.variantB, results);
  const deltaPassRate = Number((summaryB.passRate - summaryA.passRate).toFixed(1));
  const deltaPassedCount = summaryB.passedCount - summaryA.passedCount;
  const winner: "A" | "B" | "tie" =
    deltaPassedCount > 0 ? "B" : deltaPassedCount < 0 ? "A" : "tie";

  const validationLeakFailures = validations.filter((v) => !v.leakCheckPassed).length;
  const leakViolationsTotal =
    validationLeakFailures + summaryA.leakViolationsCount + summaryB.leakViolationsCount;

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const dbPath =
    options.dbPath ?? path.join(path.resolve(options.repoPath), ".commitbench", "runs.sqlite");

  const report: CompareReport = {
    runId,
    createdAt: new Date().toISOString(),
    repoPath: path.resolve(options.repoPath),
    testCommand: options.testCommand,
    taskCount: options.tasks.length,
    validTaskCount: activeTasks.length,
    leakViolationsTotal,
    variants: [summaryA, summaryB],
    deltaPassRate,
    deltaPassedCount,
    winner,
    validations,
    results,
    tasks: options.tasks,
    dbPath,
  };

  const store = new RunStore(dbPath);
  try {
    store.saveReport(report);
  } finally {
    store.close();
  }

  return report;
}
