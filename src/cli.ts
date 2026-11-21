#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "./demo/fixture.js";
import { loadTasksFile, mineTasks, saveTasksFile } from "./git/miner.js";
import {
  formatHtmlReport,
  formatMarkdownReport,
  formatTerminalReport,
} from "./report/format.js";
import { compareVariants, validateTask } from "./runner/compare.js";
import type { MinedTask, ValidationResult } from "./types.js";

const VERSION = "0.1.0";

function printHelp(): void {
  const text = `commitbench v${VERSION}
Turn your own git history into a leak-proof benchmark for coding agents, models, and AGENTS.md prompts.

Usage:
  commitbench --demo [--json] [--markdown] [--html <file>]
  commitbench mine [--repo <path>] [--days 45] [--limit 15] [--validate] [--cmd <testCmd>] [--out <file>] [--json]
  commitbench compare --a <cmdA> --b <cmdB> [options]

Commands:
  mine       Scan recent git history for commits touching both source and test files.
  compare    Run two headless agent commands A vs B in leak-proof sandboxes and grade via hidden testPatch.

Options:
  --demo                 Run self-contained end-to-end demo (3 bug-fix commits, 2 simulated agents).
  --repo <path>          Target git repository path (default: current working directory).
  --days <n>             Look back N days in git history (default: 45).
  --since <expr>         Explicit git --since date expression (overrides --days).
  --limit <n>            Maximum tasks to mine (default: 15).
  --validate             Run pre-flight validation (baseSha + testPatch fails, fixSha passes).
  --cmd <testCmd>        Test command used for validation and grading (default: "npm test").
  --out <file>           Write mined tasks JSON to a file.
  --tasks <file>         Load pre-mined tasks JSON file instead of mining git history.
  --a <cmd>              Headless command for Variant A (receives COMMITBENCH_PROMPT_FILE & COMMITBENCH_WORKDIR).
  --b <cmd>              Headless command for Variant B (receives COMMITBENCH_PROMPT_FILE & COMMITBENCH_WORKDIR).
  --label-a <name>       Display label for Variant A (default: "Variant A").
  --label-b <name>       Display label for Variant B (default: "Variant B").
  --concurrency <n>      Parallel worker count (default: 2).
  --timeout <ms>         Agent command timeout in ms (default: 120000).
  --test-timeout <ms>    Test command timeout in ms (default: 60000).
  --db <file>            SQLite WAL database path (default: <repo>/.commitbench/runs.sqlite).
  --skip-validate        Skip pre-flight validation during compare.
  --markdown             Output Markdown PR report.
  --json                 Output raw JSON report.
  --html <file>          Write standalone XSS-escaped HTML report to <file>.
  -v, --version          Show version number.
  -h, --help             Show this help message.
`;
  process.stdout.write(text);
}

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  const valueFlags = new Set([
    "repo",
    "days",
    "since",
    "limit",
    "cmd",
    "out",
    "tasks",
    "a",
    "b",
    "label-a",
    "label-b",
    "concurrency",
    "timeout",
    "test-timeout",
    "db",
    "html",
  ]);

  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (!token.startsWith("-") && command === undefined) {
      command = token;
      i += 1;
      continue;
    }
    if (token === "-h" || token === "--help") {
      flags.help = true;
      i += 1;
      continue;
    }
    if (token === "-v" || token === "--version") {
      flags.version = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        const value = token.slice(eqIdx + 1);
        flags[key] = value;
        i += 1;
        continue;
      }
      const key = token.slice(2);
      if (valueFlags.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("--") && key !== "a" && key !== "b" && key !== "cmd")) {
          throw new Error(`Missing value for option --${key}`);
        }
        flags[key] = next;
        i += 2;
        continue;
      }
      flags[key] = true;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { command, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function getIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: number,
): number {
  const raw = getStringFlag(flags, key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for --${key}: "${raw}"`);
  }
  return parsed;
}

function outputCompareReport(
  report: Awaited<ReturnType<typeof compareVariants>>,
  flags: Record<string, string | boolean>,
): void {
  const htmlPath = getStringFlag(flags, "html");
  if (htmlPath) {
    const resolved = path.resolve(htmlPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, formatHtmlReport(report), "utf8");
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (flags.markdown) {
    process.stdout.write(`${formatMarkdownReport(report)}\n`);
  } else {
    process.stdout.write(`${formatTerminalReport(report)}\n`);
  }
}

async function handleMine(flags: Record<string, string | boolean>): Promise<void> {
  const repoPath = getStringFlag(flags, "repo") ?? process.cwd();
  const days = getIntFlag(flags, "days", 45);
  const limit = getIntFlag(flags, "limit", 15);
  const since = getStringFlag(flags, "since");
  const validate = Boolean(flags.validate);
  const testCommand = getStringFlag(flags, "cmd") ?? "npm test";
  const outFile = getStringFlag(flags, "out");

  const tasks = mineTasks({
    repoPath,
    days: since ? undefined : days,
    since,
    limit,
  });

  const validations: ValidationResult[] = [];
  if (validate) {
    for (const task of tasks) {
      const result = await validateTask(task, {
        testCommand,
        timeoutMs: getIntFlag(flags, "test-timeout", 60_000),
      });
      validations.push(result);
    }
  }

  if (outFile) {
    const validIds = validate
      ? new Set(validations.filter((v) => v.valid).map((v) => v.taskId))
      : null;
    const toSave = validIds ? tasks.filter((t) => validIds.has(t.id)) : tasks;
    saveTasksFile(outFile, toSave);
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ repoPath: path.resolve(repoPath), taskCount: tasks.length, tasks, validations }, null, 2)}\n`,
    );
    return;
  }

  const lines: string[] = [
    `Mined ${tasks.length} task(s) from ${path.resolve(repoPath)}`,
  ];
  for (const task of tasks) {
    const val = validations.find((v) => v.taskId === task.id);
    const valSuffix = val
      ? val.valid
        ? " [VALID]"
        : ` [INVALID: ${val.reason ?? "validation failed"}]`
      : "";
    lines.push(
      `  - ${task.id} (${task.shortSha}) | src=${task.sourceFiles.length} test=${task.testFiles.length}${valSuffix} | ${task.originalSubject}`,
    );
  }
  if (outFile) {
    lines.push(`Saved tasks to ${path.resolve(outFile)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function handleCompare(flags: Record<string, string | boolean>): Promise<void> {
  const cmdA = getStringFlag(flags, "a");
  const cmdB = getStringFlag(flags, "b");
  if (!cmdA || !cmdB) {
    throw new Error("Both --a <cmdA> and --b <cmdB> are required for compare.");
  }

  const repoPath = getStringFlag(flags, "repo") ?? process.cwd();
  const tasksFile = getStringFlag(flags, "tasks");
  const testCommand = getStringFlag(flags, "cmd") ?? "npm test";
  const labelA = getStringFlag(flags, "label-a") ?? "Variant A";
  const labelB = getStringFlag(flags, "label-b") ?? "Variant B";
  const concurrency = getIntFlag(flags, "concurrency", 2);
  const agentTimeoutMs = getIntFlag(flags, "timeout", 120_000);
  const testTimeoutMs = getIntFlag(flags, "test-timeout", 60_000);
  const dbPath = getStringFlag(flags, "db");
  const validateFirst = !Boolean(flags["skip-validate"]);

  let tasks: MinedTask[];
  if (tasksFile) {
    tasks = loadTasksFile(tasksFile);
  } else {
    const days = getIntFlag(flags, "days", 45);
    const limit = getIntFlag(flags, "limit", 15);
    const since = getStringFlag(flags, "since");
    tasks = mineTasks({
      repoPath,
      days: since ? undefined : days,
      since,
      limit,
    });
  }

  if (tasks.length === 0) {
    throw new Error("No qualifying tasks found to compare.");
  }

  const report = await compareVariants({
    repoPath,
    tasks,
    variantA: { id: "A", label: labelA, command: cmdA },
    variantB: { id: "B", label: labelB, command: cmdB },
    testCommand,
    concurrency,
    agentTimeoutMs,
    testTimeoutMs,
    validateFirst,
    dbPath,
  });

  outputCompareReport(report, flags);
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const { command, flags } = parseCliArgs(argv);

    if (flags.help || (!command && !flags.demo && !flags.version)) {
      printHelp();
      return 0;
    }

    if (flags.version) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }

    if (flags.demo || command === "demo") {
      const report = await runDemo();
      outputCompareReport(report, flags);
      return 0;
    }

    if (command === "mine") {
      await handleMine(flags);
      return 0;
    }

    if (command === "compare") {
      await handleCompare(flags);
      return 0;
    }

    throw new Error(`Unknown command: "${command ?? ""}". Run "commitbench --help" for usage.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`commitbench error: ${message}\n`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const resolvedEntry = fs.realpathSync(entry);
    const resolvedSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    if (resolvedEntry === resolvedSelf) {
      return true;
    }
  } catch {
    // Fallback to basename matching if realpath fails.
  }
  const base = path.basename(entry).toLowerCase();
  return base.startsWith("cli.") || base.startsWith("commitbench");
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
