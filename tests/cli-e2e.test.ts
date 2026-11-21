import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoFixture } from "../src/demo/fixture.js";
import type { CompareReport } from "../src/types.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

async function runBuiltCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

describe("built dist/cli.js E2E", () => {
  it("preserves node: protocol imports in dist/cli.js", () => {
    expect(fs.existsSync(CLI_PATH)).toBe(true);
    const built = fs.readFileSync(CLI_PATH, "utf8");
    expect(built).toContain("node:sqlite");
    expect(built.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("prints help and version cleanly", async () => {
    const help = await runBuiltCli(["--help"]);
    expect(help).toContain("commitbench v0.1.0");
    expect(help).toContain("commitbench mine");
    expect(help).toContain("commitbench compare");
    expect(help).not.toContain("\u2014");

    const ver = (await runBuiltCli(["--version"])).trim();
    expect(ver).toBe("0.1.0");
  });

  it("runs built dist/cli.js --demo --json end-to-end", async () => {
    const out = await runBuiltCli(["--demo", "--json"]);
    const report = JSON.parse(out) as CompareReport;

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
  });

  it("runs --demo --markdown and writes standalone --html report", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commitbench-cli-html-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const htmlPath = path.join(tmp, "report.html");

    const md = await runBuiltCli(["--demo", "--markdown", "--html", htmlPath]);
    expect(md).toContain("## commitbench A/B Benchmark Report");
    expect(md).toContain("0 git-leak violations");
    expect(md).not.toContain("\u2014");

    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("0 violations");
    expect(html).not.toContain("\u2014");
  });

  it("runs mine --validate and compare via CLI on a repo fixture", async () => {
    const fixture = createDemoFixture();
    cleanups.push(fixture.cleanup);

    const tasksPath = path.join(fixture.rootDir, "mined.json");
    const dbPath = path.join(fixture.rootDir, "cli-runs.sqlite");

    const mineOut = await runBuiltCli([
      "mine",
      "--repo",
      fixture.repoDir,
      "--days",
      "45",
      "--limit",
      "10",
      "--validate",
      "--cmd",
      fixture.testCommand,
      "--out",
      tasksPath,
      "--json",
    ]);
    const mineJson = JSON.parse(mineOut) as {
      taskCount: number;
      validations: Array<{ valid: boolean }>;
    };
    expect(mineJson.taskCount).toBe(3);
    expect(mineJson.validations.every((v) => v.valid)).toBe(true);
    expect(fs.existsSync(tasksPath)).toBe(true);

    const compareOut = await runBuiltCli([
      "compare",
      "--repo",
      fixture.repoDir,
      "--tasks",
      tasksPath,
      "--a",
      fixture.variantA.command,
      "--b",
      fixture.variantB.command,
      "--label-a",
      "Baseline",
      "--label-b",
      "AGENTS.md v2",
      "--cmd",
      fixture.testCommand,
      "--db",
      dbPath,
      "--skip-validate",
      "--json",
    ]);
    const report = JSON.parse(compareOut) as CompareReport;
    expect(report.validTaskCount).toBe(3);
    expect(report.variants[0].passedCount).toBe(1);
    expect(report.variants[1].passedCount).toBe(3);
    expect(report.winner).toBe("B");
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
