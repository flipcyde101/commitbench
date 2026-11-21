import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatHtmlReport,
  formatMarkdownReport,
  formatTerminalReport,
} from "../src/report/format.js";
import type { CompareReport } from "../src/types.js";

function makeSampleReport(): CompareReport {
  return {
    runId: "run-2026-test",
    createdAt: "2026-11-21T19:00:00.000Z",
    repoPath: "/tmp/sample",
    testCommand: "node --test",
    taskCount: 2,
    validTaskCount: 2,
    leakViolationsTotal: 0,
    variants: [
      {
        variantId: "A",
        variantLabel: 'Baseline <script>alert("A")</script>',
        passedCount: 1,
        totalCount: 2,
        passRate: 50,
        failToPassCount: 1,
        passToPassCount: 2,
        leakViolationsCount: 0,
        avgAgentDurationMs: 120,
        totalDurationMs: 350,
      },
      {
        variantId: "B",
        variantLabel: "Improved AGENTS.md",
        passedCount: 2,
        totalCount: 2,
        passRate: 100,
        failToPassCount: 2,
        passToPassCount: 2,
        leakViolationsCount: 0,
        avgAgentDurationMs: 145,
        totalDurationMs: 410,
      },
    ],
    deltaPassRate: 50,
    deltaPassedCount: 1,
    winner: "B",
    validations: [],
    tasks: [
      {
        id: "task-11111111",
        repoPath: "/tmp/sample",
        baseSha: "0".repeat(40),
        fixSha: "1".repeat(40),
        shortSha: "11111111",
        commitDate: "2026-11-20T00:00:00Z",
        originalSubject: 'fix: handle <img src=x onerror="alert(1)">',
        problemStatement: "Fix issue",
        sourceFiles: ["src/a.mjs"],
        testFiles: ["tests/a.test.mjs"],
        testPatch: "diff",
        diffStats: {
          filesChanged: 2,
          sourceFilesCount: 1,
          testFilesCount: 1,
          testPatchBytes: 4,
        },
      },
      {
        id: "task-22222222",
        repoPath: "/tmp/sample",
        baseSha: "2".repeat(40),
        fixSha: "3".repeat(40),
        shortSha: "22222222",
        commitDate: "2026-11-21T00:00:00Z",
        originalSubject: "fix: second bug | pipe test",
        problemStatement: "Fix second issue",
        sourceFiles: ["src/b.mjs"],
        testFiles: ["tests/b.test.mjs"],
        testPatch: "diff",
        diffStats: {
          filesChanged: 2,
          sourceFilesCount: 1,
          testFilesCount: 1,
          testPatchBytes: 4,
        },
      },
    ],
    results: [
      {
        taskId: "task-11111111",
        variantId: "A",
        variantLabel: 'Baseline <script>alert("A")</script>',
        passed: false,
        failToPass: false,
        passToPass: true,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: 0,
        agentTimedOut: false,
        agentDurationMs: 110,
        gradeDurationMs: 50,
        changedFiles: [],
        testPatchApplied: true,
        error: "<script>bad()</script>",
      },
      {
        taskId: "task-11111111",
        variantId: "B",
        variantLabel: "Improved AGENTS.md",
        passed: true,
        failToPass: true,
        passToPass: true,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: 0,
        agentTimedOut: false,
        agentDurationMs: 140,
        gradeDurationMs: 55,
        changedFiles: ["src/a.mjs"],
        testPatchApplied: true,
      },
      {
        taskId: "task-22222222",
        variantId: "A",
        variantLabel: 'Baseline <script>alert("A")</script>',
        passed: true,
        failToPass: true,
        passToPass: true,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: 0,
        agentTimedOut: false,
        agentDurationMs: 130,
        gradeDurationMs: 60,
        changedFiles: ["src/b.mjs"],
        testPatchApplied: true,
      },
      {
        taskId: "task-22222222",
        variantId: "B",
        variantLabel: "Improved AGENTS.md",
        passed: true,
        failToPass: true,
        passToPass: true,
        leakCheckPassed: true,
        leakViolations: [],
        agentExitCode: 0,
        agentTimedOut: false,
        agentDurationMs: 150,
        gradeDurationMs: 65,
        changedFiles: ["src/b.mjs"],
        testPatchApplied: true,
      },
    ],
  };
}

describe("report formatters", () => {
  it("escapes HTML special characters against XSS", () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
    );
  });

  it("renders terminal, markdown, and HTML reports with zero em dashes and escaped HTML", () => {
    const report = makeSampleReport();

    const terminal = formatTerminalReport(report);
    expect(terminal).toContain("commitbench A/B Scorecard");
    expect(terminal).toContain("0 git-leak violations");
    expect(terminal).toContain("+50.0%");
    expect(terminal).not.toContain("\u2014");

    const markdown = formatMarkdownReport(report);
    expect(markdown).toContain("## commitbench A/B Benchmark Report");
    expect(markdown).toContain("0 git-leak violations");
    expect(markdown).toContain("pipe test");
    expect(markdown).toContain("\\|");
    expect(markdown).not.toContain("\u2014");

    const html = formatHtmlReport(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;A&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("\u2014");
  });
});
